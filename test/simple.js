const { ethers, network } = require("hardhat");

const OptionsPremiumPricerInStables_ABI = require("../abis/OptionsPremiumPricerInStables.json");
const OptionsPremiumPricerInStables_BYTECODE = require("../bytecodes/PricerInStables");

const ManualVolOracle_ABI = require("../abis/ManualVolOracle.json");
const ManualVolOracle_BYTECODE = require("../bytecodes/ManualVolOracle");

const ORACLE_ABI = require("../abis/OpynOracle.json");

const { assert } = require("chai");

const moment = require("moment-timezone");

moment.tz.setDefault('UTC');

const STETH_ADDRESS = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const LDO_ADDRESS = "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32";
const STETH_ETH_CRV_POOL = "0xDC24316b9AE028F1497c275EB9192a3Ea0f67022";
const WSTETH_PRICER = "0x4661951D252993AFa69b36bcc7Ba7da4a48813bF";
const GNOSIS_EASY_AUCTION = "0x0b7fFc1f4AD541A4Ed16b40D8c37f0929158D101"
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
const WSTETH_ADDRESS = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"
const GAMMA_CONTROLLER = "0x4ccc2339F87F6c59c6893E1A678c2266cA58dC72"
const OTOKEN_FACTORY = "0x7C06792Af1632E77cb27a558Dc0885338F4Bdf8E";
const MARGIN_POOL = "0x5934807cC0654d46755eBd2848840b616256C6Ef";
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const CHAINLINK_WETH_PRICER_STETH = "0x128cE9B4D97A6550905dE7d9Abc2b8C747b0996C";
const OPTIONS_PREMIUM_PRICER = "0x5ba2a42b74a72a1a3ccc37cf03802a0b7a551139";
const YEARN_PRICER_OWNER = "0xfacb407914655562d6619b0048a612B1795dF783";
const GAMMA_ORACLE = "0x789cD7AB3742e23Ce0952F6Bc3Eb3A73A0E08833"

const ORACLE_OWNER = "0x2FCb2fc8dD68c48F406825255B4446EDFbD3e140"

const ORACLE_LOCKING_PERIOD = 300;
const ORACLE_DISPUTE_PERIOD = 7200;
const DELAY_INCREMENT = 100;
const PERIOD = 12 * 60 * 60; // 12 hours

// https://github.com/ribbon-finance/metavault/blob/main/contracts/V2/interfaces/IRibbonVault.sol
// https://github.com/ribbon-finance/ribbon-v2/blob/master/contracts/vaults/STETHVault/RibbonThetaSTETHVault.sol
// https://docs.idle.finance/developers/perpetual-yield-tranches/methods
// https://etherscan.io/address/0x25751853eab4d0eb3652b5eb6ecb102a2789644b#readProxyContract

const increaseTo = async (amount) => {
  const target = ethers.BigNumber.from(amount);
  const timestamp = await ethers.provider.getBlock("latest").then(r => r.timestamp)
  const now = ethers.BigNumber.from(timestamp);
  const duration = ethers.BigNumber.from(target.sub(now));

  await ethers.provider.send("evm_increaseTime", [duration.toNumber()]);
  await ethers.provider.send("evm_mine", []);
}

const rollToNextOption = async (vault, ownerSigner, keeperSigner) => {
  await vault.connect(ownerSigner).commitAndClose();
  const nextOptionReadyAt = await vault.optionState().then(o => o.nextOptionReadyAt);
  await increaseTo(nextOptionReadyAt + DELAY_INCREMENT);
  await vault.connect(keeperSigner).rollToNextOption();
};

const setOpynExpiryPrice = async (vault, underlyingAsset, underlyingSettlePrice, ownerSigner) => {

  await network.provider.request({ method: "hardhat_impersonateAccount", params: [CHAINLINK_WETH_PRICER_STETH] });
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [ORACLE_OWNER] });
  const oracleOwnerSigner2 = await ethers.provider.getSigner(ORACLE_OWNER);

  const pricerSigner = await ethers.provider.getSigner(CHAINLINK_WETH_PRICER_STETH);
  const forceSendContract = await ethers.getContractFactory("ForceSend");
  const forceSend = await forceSendContract.deploy(); // forces the sending of Ether to WBTC minter
  await forceSend.connect(ownerSigner).go(CHAINLINK_WETH_PRICER_STETH, { value: ethers.utils.parseEther("1") });

  const oracle = new ethers.Contract(GAMMA_ORACLE, ORACLE_ABI, pricerSigner);
  await ownerSigner.sendTransaction({ to: ORACLE_OWNER, value: ethers.utils.parseEther("1"), });

  await oracle.connect(oracleOwnerSigner2).setStablePrice(USDC_ADDRESS, "100000000");
  await oracle.connect(oracleOwnerSigner2).setAssetPricer(underlyingAsset, CHAINLINK_WETH_PRICER_STETH);

  const currentOption = await vault.currentOption();
  const otoken = await ethers.getContractAt("IOtoken", currentOption);
  const expiry = await otoken.expiryTimestamp()

  await network.provider.request({ method: "hardhat_impersonateAccount", params: [WSTETH_PRICER] });
  const pricerContract = await ethers.getContractAt("IYearnPricer", WSTETH_PRICER);
  await forceSend.connect(ownerSigner).go(WSTETH_PRICER, { value: ethers.utils.parseEther("0.5") });
  const collateralPricer  = await pricerContract.connect(ownerSigner);

  await increaseTo(expiry.toNumber() + ORACLE_LOCKING_PERIOD + 1);

  await oracle.setExpiryPrice(underlyingAsset, expiry, underlyingSettlePrice).then(r => r.wait());
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [YEARN_PRICER_OWNER], });

  const oracleOwnerSigner = await ethers.provider.getSigner(YEARN_PRICER_OWNER);
  const res2 = await collateralPricer.connect(oracleOwnerSigner).setExpiryPriceInOracle(expiry);
  const receipt = await res2.wait();

  const timestamp = (await ethers.provider.getBlock(receipt.blockNumber)).timestamp;
  await increaseTo(timestamp + ORACLE_DISPUTE_PERIOD + 1);
};

describe("RibbonThetaSTETHVault - stETH (Call) - #completeWithdraw", () => {

  // contracts
  let strikeSelection, vault;

  // parameters
  let asset = WETH_ADDRESS;

  before(async function () {

    // get signers
    const [adminSigner, ownerSigner, keeperSigner, userSigner, feeRecipientSigner] = await ethers.getSigners();

    // get wrapped ether
    const depositAsset = WETH_ADDRESS;
    const assetContract = await ethers.getContractAt("IWETH", depositAsset);
    await assetContract.connect(userSigner).deposit({ value: ethers.utils.parseEther("100") });

    // deploy strike selection oracle
    const deltaStep = ethers.BigNumber.from("100");
    const deltaFirstOption = ethers.BigNumber.from("1000")
    const OptionsPremiumPricer = await ethers.getContractFactory(OptionsPremiumPricerInStables_ABI, OptionsPremiumPricerInStables_BYTECODE, ownerSigner);
    const optionsPremiumPricer = OptionsPremiumPricer.attach(OPTIONS_PREMIUM_PRICER);
    const StrikeSelection = await ethers.getContractFactory("DeltaStrikeSelection", ownerSigner);
    strikeSelection = await StrikeSelection.deploy(optionsPremiumPricer.address, deltaFirstOption, ethers.BigNumber.from(deltaStep).mul(10 ** 8));
    
    // deploy vault proxy
    const VaultLifecycle = await ethers.getContractFactory("VaultLifecycle");
    const vaultLifecycleLib = await VaultLifecycle.deploy();
    const VaultLifecycleSTETH = await ethers.getContractFactory("VaultLifecycleSTETH");
    const vaultLifecycleSTETHLib = await VaultLifecycleSTETH.deploy();
    const options =[false, 18, asset, asset, ethers.BigNumber.from("10").pow("10").toString(), ethers.utils.parseEther("500")];
    const initializeArgs = [ ownerSigner.address, keeperSigner.address, feeRecipientSigner.address, ethers.BigNumber.from("2000000"), ethers.BigNumber.from("20000000"), 
      "Ribbon ETH Theta Vault stETH", "rSTETH-THETA", optionsPremiumPricer.address, strikeSelection.address, ethers.BigNumber.from("997"), 21600, options];
    const deployArgs = [WETH_ADDRESS, USDC_ADDRESS, WSTETH_ADDRESS, LDO_ADDRESS, 
      OTOKEN_FACTORY, GAMMA_CONTROLLER, MARGIN_POOL, GNOSIS_EASY_AUCTION, STETH_ETH_CRV_POOL];
    const libs = { VaultLifecycle: vaultLifecycleLib.address, VaultLifecycleSTETH: vaultLifecycleSTETHLib.address };
    const AdminUpgradeabilityProxy = await ethers.getContractFactory("AdminUpgradeabilityProxy", adminSigner);
    const LogicContract = await ethers.getContractFactory("RibbonThetaSTETHVault", { libraries: libs });
    const logic = await LogicContract.deploy(...deployArgs);
    const initBytes = LogicContract.interface.encodeFunctionData("initialize", initializeArgs);
    const proxy = await AdminUpgradeabilityProxy.deploy(logic.address, await adminSigner.getAddress(), initBytes);
    const deployVaultTx = await ethers.getContractAt("RibbonThetaSTETHVault", proxy.address);
    vault = deployVaultTx.connect(userSigner);

  });

  it("completes the withdrawal", async function () {

    // get signers
    const [, ownerSigner, keeperSigner, userSigner] = await ethers.getSigners();

    // deposit eth into the vault
    const depositAmount = ethers.utils.parseEther("1");
    await vault.depositETH({ value: depositAmount });
    await vault.connect(ownerSigner).depositETH({ value: depositAmount });

    // initialize withdraw
    const {timestamp} = await ethers.provider.getBlock("latest");
    const duration = (timestamp % PERIOD < Math.floor(PERIOD / 2) ? -1 : 1) * (timestamp % PERIOD) + 2 * PERIOD;
    await increaseTo(timestamp + duration);
    await rollToNextOption(vault, ownerSigner, keeperSigner);
    await vault.initiateWithdraw(depositAmount);

    // update opyn price
    const latestTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
    const firstOptionExpiry = moment(latestTimestamp * 1000).startOf("isoWeek").add(1, "weeks").day("friday").hours(8).minutes(0).seconds(0).unix();
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
