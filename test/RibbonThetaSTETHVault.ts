import { ethers } from "hardhat";

import OptionsPremiumPricerInStables_ABI from "../abis/OptionsPremiumPricerInStables.json";
import ManualVolOracle_ABI from "../abis/ManualVolOracle.json";

import { OptionsPremiumPricerInStables_BYTECODE, ManualVolOracle_BYTECODE } from "./helpers/constants";

import { deployProxy, setupOracle, setOpynOracleExpiryPriceYearn, getAssetPricer, whitelistProduct } from "./helpers/utils";
import { assert } from "chai";

import moment from "moment-timezone";

moment.tz.setDefault('UTC');

const { provider, getContractAt, getContractFactory, BigNumber, utils } = ethers;

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
const WETH_PRICE_ORACLE_ADDRESS = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const USDC_PRICE_ORACLE_ADDRESS = "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6";

const DELAY_INCREMENT = 100;
const PERIOD = 43200; // 12 hours

const getTopOfPeriod = async () => {
  const latestTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
  let topOfPeriod: number;

  const rem = latestTimestamp % PERIOD;
  if (rem < Math.floor(PERIOD / 2)) {
    topOfPeriod = latestTimestamp - rem + PERIOD;
  } else {
    topOfPeriod = latestTimestamp + rem + PERIOD;
  }
  return topOfPeriod;
}

const increase = async (duration) => {
  if (!BigNumber.isBigNumber(duration)) {
    duration = BigNumber.from(duration);
  }

  if (duration.lt(BigNumber.from("0")))
    throw Error(`Cannot increase time by a negative amount (${duration})`);

  await ethers.provider.send("evm_increaseTime", [duration.toNumber()]);

  await ethers.provider.send("evm_mine", []);
}

const increaseTo = async (target) => {
  if (!BigNumber.isBigNumber(target)) {
    target = BigNumber.from(target);
  }

  const now = BigNumber.from(
    (await ethers.provider.getBlock("latest")).timestamp
  );

  if (target.lt(now))
    throw Error(
      `Cannot increase current time (${now}) to a moment in the past (${target})`
    );

  const diff = target.sub(now);
  return increase(diff);
}

describe("RibbonThetaSTETHVault - stETH (Call) - #completeWithdraw", () => {

  // Contracts
  let strikeSelection, intermediaryAssetContract, vault;

  // Parameters
  let asset = WETH_ADDRESS;

  const rollToNextOption = async (ownerSigner, keeperSigner) => {
    await vault.connect(ownerSigner).commitAndClose();
    const nextOptionReadyAt = await vault.optionState().then(o => o.nextOptionReadyAt);
    await increaseTo(nextOptionReadyAt + DELAY_INCREMENT);
    await vault.connect(keeperSigner).rollToNextOption();
  };

  const setOpynExpiryPrice = async (settlementPrice, ownerSigner) => {
    const oracle = await setupOracle(asset, CHAINLINK_WETH_PRICER_STETH, ownerSigner, 1);
    const currentOption = await vault.currentOption();
    const otoken = await getContractAt("IOtoken", currentOption);
    const expiry = await otoken.expiryTimestamp()
    const collateralPricerSigner = await getAssetPricer(WSTETH_PRICER, ownerSigner);
    await setOpynOracleExpiryPriceYearn(asset, oracle, settlementPrice, collateralPricerSigner, expiry);
  };

  before(async function () {

    // get signers
    const [adminSigner, ownerSigner, keeperSigner, userSigner, feeRecipientSigner] = await ethers.getSigners();

    // deploy oracle
    const asset = WETH_ADDRESS;
    const collateralAsset = WSTETH_ADDRESS;
    const deltaStep = BigNumber.from("100");
    const TestVolOracle = await getContractFactory(ManualVolOracle_ABI, ManualVolOracle_BYTECODE, keeperSigner);
    const volOracle = await TestVolOracle.deploy(keeperSigner.address);
    const optionId = await volOracle.getOptionId(deltaStep, asset, collateralAsset, false);
    await volOracle.setAnnualizedVol([optionId], [106480000]);
    
    // increase timestamp
    const topOfPeriod = (await getTopOfPeriod()) + PERIOD;
    await increaseTo(topOfPeriod);
    
    // deploy pricer
    const OptionsPremiumPricer = await getContractFactory(OptionsPremiumPricerInStables_ABI, OptionsPremiumPricerInStables_BYTECODE, ownerSigner);
    const optionsPremiumPricer = await OptionsPremiumPricer.deploy(optionId, volOracle.address, WETH_PRICE_ORACLE_ADDRESS, USDC_PRICE_ORACLE_ADDRESS);
    
    // deploy strike selection
    const deltaFirstOption = BigNumber.from("1000")
    const StrikeSelection = await getContractFactory("DeltaStrikeSelection", ownerSigner);
    strikeSelection = await StrikeSelection.deploy(optionsPremiumPricer.address, deltaFirstOption, BigNumber.from(deltaStep).mul(10 ** 8));
    
    // get libraries
    const VaultLifecycle = await ethers.getContractFactory("VaultLifecycle");
    const vaultLifecycleLib = await VaultLifecycle.deploy();
    const VaultLifecycleSTETH = await ethers.getContractFactory("VaultLifecycleSTETH");
    const vaultLifecycleSTETHLib = await VaultLifecycleSTETH.deploy();
    
    // deploy vault contract
    const tokenName = "Ribbon ETH Theta Vault stETH";
    const tokenSymbol = "rSTETH-THETA";
    const tokenDecimals = 18;
    const minimumSupply = BigNumber.from("10").pow("10").toString();
    const premiumDiscount = BigNumber.from("997");
    const managementFee = BigNumber.from("2000000");
    const performanceFee = BigNumber.from("20000000");
    const auctionDuration = 21600;
    const options =[false, tokenDecimals, asset, asset, minimumSupply, utils.parseEther("500")];
    const initializeArgs = [ ownerSigner.address, keeperSigner.address, feeRecipientSigner.address, managementFee, performanceFee, 
      tokenName, tokenSymbol, optionsPremiumPricer.address, strikeSelection.address, premiumDiscount, auctionDuration, options];
    const deployArgs = [WETH_ADDRESS, USDC_ADDRESS, WSTETH_ADDRESS, LDO_ADDRESS, 
      OTOKEN_FACTORY, GAMMA_CONTROLLER, MARGIN_POOL, GNOSIS_EASY_AUCTION, STETH_ETH_CRV_POOL];
    const libs = { VaultLifecycle: vaultLifecycleLib.address, VaultLifecycleSTETH: vaultLifecycleSTETHLib.address };
    vault = (
      await deployProxy("RibbonThetaSTETHVault", adminSigner, initializeArgs, deployArgs, { libraries: libs })
    ).connect(userSigner);

    // deploy assets contracts
    const intermediaryAsset = STETH_ADDRESS;
    const depositAsset = WETH_ADDRESS;
    const assetContract = await getContractAt("IWETH", depositAsset);
    await assetContract.connect(userSigner).deposit({ value: utils.parseEther("100") });
    intermediaryAssetContract = await getContractAt("IERC20", intermediaryAsset);

    // whitelist product
    const strikeAsset = USDC_ADDRESS
    await whitelistProduct(asset, strikeAsset, collateralAsset, false, 1);

  });

  it("completes the withdrawal", async function () {

    // get signers
    const [, ownerSigner, keeperSigner, userSigner] = await ethers.getSigners();

    // deposit eth into the vault
    let depositAmount = utils.parseEther("1");
    await vault.depositETH({ value: depositAmount });
    await vault.connect(ownerSigner).depositETH({ value: depositAmount });

    // initialize withdraw
    await rollToNextOption(ownerSigner, keeperSigner);
    await vault.initiateWithdraw(depositAmount);

    // update opyn price
    const latestTimestamp = (await provider.getBlock("latest")).timestamp;
    const firstOptionExpiry = moment(latestTimestamp * 1000).startOf("isoWeek").add(1, "weeks").day("friday").hours(8).minutes(0).seconds(0).unix();
    const [firstOptionStrike] = await strikeSelection.getStrikePrice(firstOptionExpiry, false);
    await setOpynExpiryPrice(firstOptionStrike.add(100000000), ownerSigner);
    
    // complete withdraw
    await rollToNextOption(ownerSigner, keeperSigner)
    const beforeBalance = await intermediaryAssetContract.balanceOf(userSigner.address);
    await vault.completeWithdraw({ gasPrice: utils.parseUnits("30", "gwei") });
    const afterBalance = await intermediaryAssetContract.balanceOf(userSigner.address);
    assert.ok((afterBalance.sub(beforeBalance)).lt(depositAmount));

  });
});
