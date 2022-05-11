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

const bnLt = (aBN, bBN) => assert.ok(aBN.lt(bBN), `${aBN.toString()} is not less than ${bBN.toString()}`);
const bnGte = (aBN, bBN) => assert.ok(aBN.gte(bBN), `${aBN.toString()} is not greater than or equal to ${bBN.toString()}`);
const bnLte = (aBN, bBN) => assert.ok(aBN.lte(bBN), `${aBN.toString()} is not less than or equal to ${bBN.toString()}`);

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
};

async function increase(duration) {
  if (!BigNumber.isBigNumber(duration)) {
    duration = BigNumber.from(duration);
  }

  if (duration.lt(BigNumber.from("0")))
    throw Error(`Cannot increase time by a negative amount (${duration})`);

  await ethers.provider.send("evm_increaseTime", [duration.toNumber()]);

  await ethers.provider.send("evm_mine", []);
}

async function increaseTo(target) {
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

  // Signers
  let adminSigner, userSigner, ownerSigner, keeperSigner, feeRecipientSigner;

  // Contracts
  let strikeSelection, optionsPremiumPricer, intermediaryAssetContract, assetContract, vault;

  // Parameters
  let tokenName = "Ribbon ETH Theta Vault stETH";
  let tokenSymbol = "rSTETH-THETA";
  let tokenDecimals = 18;
  let minimumSupply = BigNumber.from("10").pow("10").toString();
  let asset = WETH_ADDRESS;
  let strikeAsset = USDC_ADDRESS
  let depositAsset = WETH_ADDRESS;
  let collateralAsset = WSTETH_ADDRESS;
  let intermediaryAsset = STETH_ADDRESS;
  let depositAmount = utils.parseEther("1");
  let premiumDiscount = BigNumber.from("997");
  let managementFee = BigNumber.from("2000000");
  let performanceFee = BigNumber.from("20000000");
  let stETHAmountAfterRounding = BigNumber.from("999746414674411972");
  let auctionDuration = 21600;
  let deltaStep = BigNumber.from("100");
  let deltaFirstOption = BigNumber.from("1000")

  const rollToNextOption = async () => {
    await vault.connect(ownerSigner).commitAndClose();
    const nextOptionReadyAt = await vault.optionState().then(o => o.nextOptionReadyAt);
    await increaseTo(nextOptionReadyAt + DELAY_INCREMENT);
    await vault.connect(keeperSigner).rollToNextOption();
  };

  const setOpynExpiryPrice = async (settlementPrice) => {
    const oracle = await setupOracle(asset, CHAINLINK_WETH_PRICER_STETH, ownerSigner, 1);
    const currentOption = await vault.currentOption();
    const otoken = await getContractAt("IOtoken", currentOption);
    const expiry = await otoken.expiryTimestamp()
    const collateralPricerSigner = await getAssetPricer(WSTETH_PRICER, ownerSigner);
    await setOpynOracleExpiryPriceYearn(asset, oracle, settlementPrice, collateralPricerSigner, expiry);
  };

  before(async function () {

    [adminSigner, ownerSigner, keeperSigner, userSigner, feeRecipientSigner] = await ethers.getSigners();

    // deploy oracle
    const TestVolOracle = await getContractFactory(ManualVolOracle_ABI, ManualVolOracle_BYTECODE, keeperSigner);
    const volOracle = await TestVolOracle.deploy(keeperSigner.address);
    const optionId = await volOracle.getOptionId(deltaStep, asset, collateralAsset, false);
    await volOracle.setAnnualizedVol([optionId], [106480000]);

    // increase timestamp
    const topOfPeriod = (await getTopOfPeriod()) + PERIOD;
    await increaseTo(topOfPeriod);

    // deploy pricer
    const OptionsPremiumPricer = await getContractFactory(OptionsPremiumPricerInStables_ABI, OptionsPremiumPricerInStables_BYTECODE, ownerSigner);
    optionsPremiumPricer = await OptionsPremiumPricer.deploy(optionId, volOracle.address, WETH_PRICE_ORACLE_ADDRESS, USDC_PRICE_ORACLE_ADDRESS);

    // deploy strike selection
    const StrikeSelection = await getContractFactory("DeltaStrikeSelection", ownerSigner);
    strikeSelection = await StrikeSelection.deploy(optionsPremiumPricer.address, deltaFirstOption, BigNumber.from(deltaStep).mul(10 ** 8));

    // get libraries
    const VaultLifecycle = await ethers.getContractFactory("VaultLifecycle");
    const vaultLifecycleLib = await VaultLifecycle.deploy();
    const VaultLifecycleSTETH = await ethers.getContractFactory("VaultLifecycleSTETH");
    const vaultLifecycleSTETHLib = await VaultLifecycleSTETH.deploy();

    // deploy vault contract
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
    assetContract = await getContractAt("IWETH", depositAsset);
    await assetContract.connect(userSigner).deposit({ value: utils.parseEther("100") });
    intermediaryAssetContract = await getContractAt("IERC20", intermediaryAsset);

    // whitelist product
    await whitelistProduct(asset, strikeAsset, collateralAsset, false, 1);

  });

  it("completes the withdrawal", async function () {

    // deposit eth into the vault
    await assetContract.connect(userSigner).approve(vault.address, depositAmount);
    await vault.depositETH({ value: depositAmount });
    await assetContract.connect(userSigner).transfer(ownerSigner.address, depositAmount);
    await assetContract.connect(ownerSigner).approve(vault.address, depositAmount);
    await vault.connect(ownerSigner).depositETH({ value: depositAmount });

    // initialize withdraw
    await rollToNextOption();
    await vault.initiateWithdraw(depositAmount);

    // complete withdraw
    const latestTimestamp = (await provider.getBlock("latest")).timestamp;
    const firstOptionExpiry = moment(latestTimestamp * 1000).startOf("isoWeek").add(1, "weeks").day("friday").hours(8).minutes(0).seconds(0).unix();
    const [firstOptionStrike] = await strikeSelection.getStrikePrice(firstOptionExpiry, false);
    await setOpynExpiryPrice(firstOptionStrike.add(100000000));
    await rollToNextOption()
    const beforeBalance = await intermediaryAssetContract.balanceOf(userSigner.address);
    await vault.completeWithdraw({ gasPrice: utils.parseUnits("30", "gwei") });

    // check withdrawals
    const { round } = await vault.withdrawals(userSigner.address);
    assert.equal(round, 2);

    // check balance and withdraw amount
    const afterBalance = await intermediaryAssetContract.balanceOf(userSigner.address);
    const actualWithdrawAmount = afterBalance.sub(beforeBalance);
    bnLt(actualWithdrawAmount, depositAmount);
    bnGte(actualWithdrawAmount.add(5), stETHAmountAfterRounding);
    bnLte(actualWithdrawAmount, stETHAmountAfterRounding.add(5));
  });
});
