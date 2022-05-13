const { ethers, network } = require("hardhat");

const ORACLE_ABI = require("../abis/OpynOracle.json");

const { assert } = require("chai");

const moment = require("moment-timezone");

moment.tz.setDefault('UTC');

// constants
const ORACLE_LOCKING_PERIOD = 300;
const ORACLE_DISPUTE_PERIOD = 7200;
const DELAY_INCREMENT = 100;

// vault
const STETH_ADDRESS = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const LDO_ADDRESS = "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32";
const STETH_ETH_CRV_POOL = "0xDC24316b9AE028F1497c275EB9192a3Ea0f67022";
const WSTETH_ADDRESS = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"

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
  await vault.connect(ownerSigner).commitAndClose();
  const nextOptionReadyAt = await vault.nextOptionReadyAt().then(r => r.toNumber() + 1);
  await increaseTo(nextOptionReadyAt + DELAY_INCREMENT);
  await vault.connect(keeperSigner).rollToNextOption();
};

const setOpynExpiryPrice = async (vault, underlyingAsset, underlyingSettlePrice, ownerSigner) => {

  const forceSendContract = await ethers.getContractFactory("ForceSend");
  const forceSend = await forceSendContract.deploy(); // forces the sending of Ether to WBTC minter
  const CHAINLINK_WETH_PRICER_STETH = "0x128cE9B4D97A6550905dE7d9Abc2b8C747b0996C";
  await forceSend.connect(ownerSigner).go(CHAINLINK_WETH_PRICER_STETH, { value: ethers.utils.parseEther("1") });
  
  const GAMMA_ORACLE = "0x789cD7AB3742e23Ce0952F6Bc3Eb3A73A0E08833"
  const oracle = new ethers.Contract(GAMMA_ORACLE, ORACLE_ABI, ownerSigner);
  const ORACLE_OWNER = "0x2FCb2fc8dD68c48F406825255B4446EDFbD3e140"
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [ORACLE_OWNER] });

  const oracleOwnerSigner = await ethers.provider.getSigner(ORACLE_OWNER);

  await oracle.connect(oracleOwnerSigner).setAssetPricer(underlyingAsset, CHAINLINK_WETH_PRICER_STETH);

  const currentOption = await vault.currentOption();
  const otoken = await ethers.getContractAt("IOtoken", currentOption);
  const expiry = await otoken.expiryTimestamp();

  await increaseTo(expiry.toNumber() + ORACLE_LOCKING_PERIOD + 1);

  const WSTETH_PRICER = "0x4661951D252993AFa69b36bcc7Ba7da4a48813bF";
  const pricerContract = await ethers.getContractAt("IYearnPricer", WSTETH_PRICER);

  await network.provider.request({ method: "hardhat_impersonateAccount", params: [CHAINLINK_WETH_PRICER_STETH] });
  const pricerSigner = await ethers.provider.getSigner(CHAINLINK_WETH_PRICER_STETH);

  const YEARN_PRICER_OWNER = "0xfacb407914655562d6619b0048a612B1795dF783";
  await oracle.connect(pricerSigner).setExpiryPrice(underlyingAsset, expiry, underlyingSettlePrice);
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [YEARN_PRICER_OWNER], });

  const yearnPricerSigner = await ethers.provider.getSigner(YEARN_PRICER_OWNER);
  const receipt = await pricerContract.connect(yearnPricerSigner).setExpiryPriceInOracle(expiry);

  const block = await ethers.provider.getBlock(receipt.blockNumber);
  await increaseTo(block.timestamp + ORACLE_DISPUTE_PERIOD + 1);
};

describe("RibbonThetaSTETHVault - stETH (Call) - #completeWithdraw", () => {

  let vault;
  
  before(async function () {

    // get signers
    const [adminSigner, ownerSigner, keeperSigner, userSigner, feeRecipientSigner] = await ethers.getSigners();

    const deployVaultTxNew = await ethers.getContractAt("RibbonThetaSTETHVault", '0x25751853eab4d0eb3652b5eb6ecb102a2789644b');
    const GNOSIS_EASY_AUCTION = await deployVaultTxNew.GNOSIS_EASY_AUCTION()
    const GAMMA_CONTROLLER =  await deployVaultTxNew.GAMMA_CONTROLLER()
    const MARGIN_POOL =  await deployVaultTxNew.MARGIN_POOL()
    const OTOKEN_FACTORY = await deployVaultTxNew.OTOKEN_FACTORY()
    const USDC_ADDRESS = await deployVaultTxNew.USDC()
    const WETH_ADDRESS = await deployVaultTxNew.WETH()
    const STRIKE_SELECTION = await deployVaultTxNew.strikeSelection()
    
    // deploy vault proxy
    const strikeSelection = await ethers.getContractAt('DeltaStrikeSelection', STRIKE_SELECTION);
    const optionsPremiumPricer = await strikeSelection.optionsPremiumPricer();
    const VaultLifecycle = await ethers.getContractFactory("VaultLifecycle");
    const vaultLifecycleLib = await VaultLifecycle.deploy();
    const VaultLifecycleSTETH = await ethers.getContractFactory("VaultLifecycleSTETH");
    const vaultLifecycleSTETHLib = await VaultLifecycleSTETH.deploy();

    const options =[false, 18, WETH_ADDRESS, WETH_ADDRESS, ethers.BigNumber.from("10").pow("10").toString(), ethers.utils.parseEther("500")];
    const initializeArgs = [ ownerSigner.address, keeperSigner.address, feeRecipientSigner.address, ethers.BigNumber.from("2000000"), ethers.BigNumber.from("20000000"), 
      "Ribbon ETH Theta Vault stETH", "rSTETH-THETA", optionsPremiumPricer, strikeSelection.address, ethers.BigNumber.from("997"), 21600, options];
    const deployArgs = [WETH_ADDRESS, USDC_ADDRESS, WSTETH_ADDRESS, LDO_ADDRESS, 
      OTOKEN_FACTORY, GAMMA_CONTROLLER, MARGIN_POOL, GNOSIS_EASY_AUCTION, STETH_ETH_CRV_POOL];
    const libs = { VaultLifecycle: vaultLifecycleLib.address, VaultLifecycleSTETH: vaultLifecycleSTETHLib.address };
    const AdminUpgradeabilityProxy = await ethers.getContractFactory("AdminUpgradeabilityProxy", adminSigner);
    const LogicContract = await ethers.getContractFactory("RibbonThetaSTETHVault", { libraries: libs });
    const logic = await LogicContract.deploy(...deployArgs);
    const initBytes = LogicContract.interface.encodeFunctionData("initialize", initializeArgs);
    const proxy = await AdminUpgradeabilityProxy.deploy(logic.address, await adminSigner.getAddress(), initBytes);
    const deployVaultTx = await ethers.getContractAt("RibbonThetaSTETHVault", proxy.address);
    // const deployVaultTx = await ethers.getContractAt("RibbonThetaSTETHVault", '0x25751853eab4d0eb3652b5eb6ecb102a2789644b');
    vault = deployVaultTx.connect(userSigner);
  });

  it("completes the withdrawal", async function () {

    // get signers
    const [, ownerSigner, keeperSigner, userSigner] = await ethers.getSigners();

    // deposit eth into the vault
    const asset = await vault.WETH()
    const wethContract = await ethers.getContractAt("IWETH", asset);
    await wethContract.connect(userSigner).deposit({ value: ethers.utils.parseEther("100") });
    const depositAmount = ethers.utils.parseEther("1");
    await vault.depositETH({ value: depositAmount });
    await vault.connect(ownerSigner).depositETH({ value: depositAmount });

    // initialize withdraw
    await rollToNextOption(vault, ownerSigner, keeperSigner);
    await vault.initiateWithdraw(depositAmount);

    // update opyn price
    const latestTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
    const firstOptionExpiry = moment(latestTimestamp * 1000).startOf("isoWeek").add(1, "weeks").day("friday").hours(8).minutes(0).seconds(0).unix();
    const STRIKE_SELECTION = await vault.strikeSelection()
    const strikeSelection = await ethers.getContractAt('DeltaStrikeSelection', STRIKE_SELECTION);
    const [firstOptionStrike] = await strikeSelection.getStrikePrice(firstOptionExpiry, false);
    await setOpynExpiryPrice(vault, asset, firstOptionStrike.add(100000000), ownerSigner);

    // complete withdraw
    await rollToNextOption(vault, ownerSigner, keeperSigner)
    const intermediaryAssetContract = await ethers.getContractAt("IERC20", STETH_ADDRESS);
    const beforeBalance = await intermediaryAssetContract.balanceOf(userSigner.address);
    await vault.completeWithdraw({ gasPrice: ethers.utils.parseUnits("30", "gwei") });
    const afterBalance = await intermediaryAssetContract.balanceOf(userSigner.address);
    assert.ok((afterBalance.sub(beforeBalance)).lt(depositAmount));

  });
});
