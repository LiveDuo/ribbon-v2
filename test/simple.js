const { ethers, network } = require("hardhat");

const { assert } = require("chai");

const moment = require("moment-timezone");

moment.tz.setDefault('UTC');

// constants
const ORACLE_LOCKING_PERIOD = 300;
const ORACLE_DISPUTE_PERIOD = 7200;

// vault
const STETH_ADDRESS = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const GAMMA_ORACLE = "0x789cD7AB3742e23Ce0952F6Bc3Eb3A73A0E08833";
const ORACLE_OWNER = "0x2FCb2fc8dD68c48F406825255B4446EDFbD3e140";
const CHAINLINK_WETH_PRICER_STETH = "0x128cE9B4D97A6550905dE7d9Abc2b8C747b0996C";
const WSTETH_PRICER = "0x4661951D252993AFa69b36bcc7Ba7da4a48813bF";
const YEARN_PRICER_OWNER = "0xfacb407914655562d6619b0048a612B1795dF783";
const VAULT_ADDRESS = "0x25751853eab4d0eb3652b5eb6ecb102a2789644b";

const increaseTo = async (amount) => {
  const target = ethers.BigNumber.from(amount);
  const block = await ethers.provider.getBlock("latest");
  const now = ethers.BigNumber.from(block.timestamp);
  const duration = ethers.BigNumber.from(target.sub(now));

  await ethers.provider.send("evm_increaseTime", [duration.toNumber()]);
  await ethers.provider.send("evm_mine", []);
}

const setOpynExpiryPrice = async (vault, underlyingAsset, underlyingSettlePrice, opynOracle, stethPricer, wethPricerSigner, stethPricerSigner) => {
  
  // increase time (oracle locking period)
  const currentOption = await vault.currentOption();
  const otoken = await ethers.getContractAt("IOtoken", currentOption);
  const expiry = await otoken.expiryTimestamp();
  await increaseTo(expiry.toNumber() + ORACLE_LOCKING_PERIOD + 1);

  // set expiry price
  await opynOracle.connect(wethPricerSigner).setExpiryPrice(underlyingAsset, expiry, underlyingSettlePrice);
  
  // set expiry price in oracle
  const receipt = await stethPricer.connect(stethPricerSigner).setExpiryPriceInOracle(expiry);

  // increase time (oracle dispute period)
  const block = await ethers.provider.getBlock(receipt.blockNumber);
  await increaseTo(block.timestamp + ORACLE_DISPUTE_PERIOD + 1);
};

// contracts: RibbonThetaSTETHVault, IYearnPricer, ForceSend, IWETH, IERC20, IChainlinkOracle

describe("RibbonThetaSTETHVault - stETH (Call) - #completeWithdraw", () => {

  // contracts
  let vault, opynOracle, stethPricer, wethContract, intermediaryAssetContract;

  // signers
  let wethPricerSigner, stethPricerSigner, keeperSigner, vaultSigner;
  
  before(async function () {

    const [ownerSigner] = await ethers.getSigners();

    console.log('getting contract & signers...')

    // get vault proxy contract
    vault = await ethers.getContractAt("IRibbonThetaSTETHVault", VAULT_ADDRESS);
    
    // get oracle contract
    opynOracle = await ethers.getContractAt("IChainlinkOracle", GAMMA_ORACLE, ownerSigner);

    // get oracle contract
    stethPricer = await ethers.getContractAt("IYearnPricer", WSTETH_PRICER);

    // get force send contract
    const forceSendContract = await ethers.getContractFactory("ForceSend");
    const forceSend = await forceSendContract.deploy(); 
    
    // get weth contract
    const assetAddress = await vault.WETH();
    wethContract = await ethers.getContractAt("IWETH", assetAddress);

    // get intermediary asset contract
    intermediaryAssetContract = await ethers.getContractAt("IERC20", STETH_ADDRESS);

    // get vault signer
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [vault.address] });
    vaultSigner = await ethers.provider.getSigner(vault.address);
    await ownerSigner.sendTransaction({to: vaultSigner._address, value: ethers.utils.parseEther('10')})
    
    // get keeper signer
    const keeperAddress = await vault.keeper()
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [keeperAddress] });
    keeperSigner = await ethers.provider.getSigner(keeperAddress);

    // get weth pricer signer
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [CHAINLINK_WETH_PRICER_STETH] });
    wethPricerSigner = await ethers.provider.getSigner(CHAINLINK_WETH_PRICER_STETH);
    
    // get steth pricer signer
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [YEARN_PRICER_OWNER], });
    await ownerSigner.sendTransaction({to: YEARN_PRICER_OWNER, value: ethers.utils.parseEther('10')})
    stethPricerSigner = await ethers.provider.getSigner(YEARN_PRICER_OWNER);

    // get oracle owner signer
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [ORACLE_OWNER] });
    const oracleOwnerSigner = await ethers.provider.getSigner(ORACLE_OWNER);
    await ownerSigner.sendTransaction({to: oracleOwnerSigner._address, value: ethers.utils.parseEther('10')})

    // force send ether
    const forceSendAmount = ethers.utils.parseEther("0.5")
    await forceSend.connect(ownerSigner).go(CHAINLINK_WETH_PRICER_STETH, { value: forceSendAmount });

    // set asset pricer
    await opynOracle.connect(oracleOwnerSigner).setAssetPricer(assetAddress, CHAINLINK_WETH_PRICER_STETH);

  });

  it("completes the withdrawal", async function () {

    // get signers
    const [ownerSigner] = await ethers.getSigners();

    // deposit eth into the vault
    console.log('depositing eth...')
    const assetAddress = wethContract.address;
    const depositAmount = ethers.utils.parseEther("1");
    await wethContract.connect(ownerSigner).deposit({ value: ethers.utils.parseEther("100") });
    await vault.connect(ownerSigner).depositETH({ value: depositAmount });

    // initialize withdraw
    console.log('initializing withdraw...')
    await setOpynExpiryPrice(vault, assetAddress, 100000000, opynOracle, stethPricer, wethPricerSigner, stethPricerSigner);
    await vault.connect(ownerSigner).commitAndClose();
    await vault.connect(keeperSigner).rollToNextOption();
    await vault.connect(vaultSigner).transfer(ownerSigner.address, depositAmount)
    await vault.connect(ownerSigner).initiateWithdraw(depositAmount);
    
    // complete withdraw
    console.log('completing withdraw...')
    await setOpynExpiryPrice(vault, assetAddress, 100000000, opynOracle, stethPricer, wethPricerSigner, stethPricerSigner);
    await vault.connect(ownerSigner).commitAndClose();
    await vault.connect(keeperSigner).rollToNextOption();
    const balanceBefore = await intermediaryAssetContract.balanceOf(ownerSigner.address);
    await vault.connect(ownerSigner).completeWithdraw();
    const balanceAfter = await intermediaryAssetContract.balanceOf(ownerSigner.address);
    assert.ok((balanceAfter).gt(balanceBefore.sub(depositAmount)));

  });
});
