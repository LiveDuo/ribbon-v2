const { ethers, network } = require("hardhat");

const ORACLE_ABI = require("../abis/OpynOracle.json");

const { assert } = require("chai");

const moment = require("moment-timezone");

moment.tz.setDefault('UTC');

// constants
const ORACLE_LOCKING_PERIOD = 300;
const ORACLE_DISPUTE_PERIOD = 7200;

// vault
const STETH_ADDRESS = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const GAMMA_ORACLE = "0x789cD7AB3742e23Ce0952F6Bc3Eb3A73A0E08833" // THIS
const ORACLE_OWNER = "0x2FCb2fc8dD68c48F406825255B4446EDFbD3e140"
const CHAINLINK_WETH_PRICER_STETH = "0x128cE9B4D97A6550905dE7d9Abc2b8C747b0996C";
const WSTETH_PRICER = "0x4661951D252993AFa69b36bcc7Ba7da4a48813bF";
const YEARN_PRICER_OWNER = "0xfacb407914655562d6619b0048a612B1795dF783";

// https://github.com/ribbon-finance/metavault/blob/main/contracts/V2/interfaces/IRibbonVault.sol
// https://github.com/ribbon-finance/ribbon-v2/blob/master/contracts/vaults/STETHVault/RibbonThetaSTETHVault.sol
// https://docs.idle.finance/developers/perpetual-yield-tranches/methods
// https://etherscan.io/address/0x25751853eab4d0eb3652b5eb6ecb102a2789644b#readProxyContract

const increaseTo = async (amount) => {
  const target = ethers.BigNumber.from(amount);
  const block = await ethers.provider.getBlock("latest")
  const now = ethers.BigNumber.from(block.timestamp);
  const duration = ethers.BigNumber.from(target.sub(now));

  await ethers.provider.send("evm_increaseTime", [duration.toNumber()]);
  await ethers.provider.send("evm_mine", []);
}

const rollToNextOption = async (vault, ownerSigner, keeperSigner) => {
  const _underlying = await vault.WETH()
  await setOpynExpiryPrice(vault, _underlying, 100000000, ownerSigner);
  await vault.connect(ownerSigner).commitAndClose();
  await vault.connect(keeperSigner).rollToNextOption();
};

const setOpynExpiryPrice = async (vault, underlyingAsset, underlyingSettlePrice, ownerSigner) => {

  const forceSendContract = await ethers.getContractFactory("ForceSend");
  const forceSend = await forceSendContract.deploy(); // forces the sending of Ether to WBTC minter
  await forceSend.connect(ownerSigner).go(CHAINLINK_WETH_PRICER_STETH, { value: ethers.utils.parseEther("0.5") });
  
  const oracle = new ethers.Contract(GAMMA_ORACLE, ORACLE_ABI, ownerSigner);
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [ORACLE_OWNER] });

  const oracleOwnerSigner = await ethers.provider.getSigner(ORACLE_OWNER);

  await oracle.connect(oracleOwnerSigner).setAssetPricer(underlyingAsset, CHAINLINK_WETH_PRICER_STETH);

  const currentOption = await vault.currentOption();
  const otoken = await ethers.getContractAt("IOtoken", currentOption);
  const expiry = await otoken.expiryTimestamp();

  await increaseTo(expiry.toNumber() + ORACLE_LOCKING_PERIOD + 1);

  const pricerContract = await ethers.getContractAt("IYearnPricer", WSTETH_PRICER);

  await network.provider.request({ method: "hardhat_impersonateAccount", params: [CHAINLINK_WETH_PRICER_STETH] });
  const pricerSigner = await ethers.provider.getSigner(CHAINLINK_WETH_PRICER_STETH);

  await oracle.connect(pricerSigner).setExpiryPrice(underlyingAsset, expiry, underlyingSettlePrice);
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [YEARN_PRICER_OWNER], });

  await ownerSigner.sendTransaction({to: YEARN_PRICER_OWNER, value: ethers.utils.parseEther('10')})

  const yearnPricerSigner = await ethers.provider.getSigner(YEARN_PRICER_OWNER);
  const receipt = await pricerContract.connect(yearnPricerSigner).setExpiryPriceInOracle(expiry);

  const block = await ethers.provider.getBlock(receipt.blockNumber);
  await increaseTo(block.timestamp + ORACLE_DISPUTE_PERIOD + 1);
};

describe("RibbonThetaSTETHVault - stETH (Call) - #completeWithdraw", () => {

  let vault;
  
  before(async function () {

    // get signers
    const [, userSigner] = await ethers.getSigners();

    // deploy vault proxy
    const deployVaultTx = await ethers.getContractAt("RibbonThetaSTETHVault", '0x25751853eab4d0eb3652b5eb6ecb102a2789644b');
    vault = deployVaultTx.connect(userSigner);
  });

  it("completes the withdrawal", async function () {

    // get signers
    const [ownerSigner, userSigner] = await ethers.getSigners();

    // deposit eth into the vault
    console.log('depositing eth...')
    const asset = await vault.WETH()
    const keeperAddress = await vault.keeper()
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [keeperAddress] });
    const keeperSigner = await ethers.provider.getSigner(keeperAddress);
    const wethContract = await ethers.getContractAt("IWETH", asset);
    await wethContract.connect(userSigner).deposit({ value: ethers.utils.parseEther("100") });
    const depositAmount = ethers.utils.parseEther("1");
    await vault.depositETH({ value: depositAmount });
    await vault.connect(ownerSigner).depositETH({ value: depositAmount });

    // initialize withdraw
    console.log('initializing withdraw...')
    await rollToNextOption(vault, ownerSigner, keeperSigner);
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [vault.address] });
    const vaultSigner = await ethers.provider.getSigner(vault.address);
    await ownerSigner.sendTransaction({to: vaultSigner._address, value: ethers.utils.parseEther('10')})
    await vault.connect(vaultSigner).transfer(ownerSigner.address, depositAmount.mul(2))
    await vault.connect(ownerSigner).initiateWithdraw(depositAmount);
    
    // complete withdraw
    console.log('completing withdraw...')
    await rollToNextOption(vault, ownerSigner, keeperSigner)
    const intermediaryAssetContract = await ethers.getContractAt("IERC20", STETH_ADDRESS);
    const beforeBalance = await intermediaryAssetContract.balanceOf(userSigner.address);
    await vault.connect(ownerSigner).completeWithdraw({ gasPrice: ethers.utils.parseUnits("30", "gwei") });
    const afterBalance = await intermediaryAssetContract.balanceOf(userSigner.address);
    assert.ok((afterBalance.sub(beforeBalance)).lt(depositAmount));

  });
});
