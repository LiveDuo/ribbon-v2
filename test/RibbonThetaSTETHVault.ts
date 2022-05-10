import { ethers, network } from "hardhat";

import OptionsPremiumPricerInStables_ABI from "../abis/OptionsPremiumPricerInStables.json";
import ManualVolOracle_ABI from "../abis/ManualVolOracle.json";

import { OPTION_PROTOCOL, CHAINLINK_WETH_PRICER_STETH, GAMMA_CONTROLLER, MARGIN_POOL, OTOKEN_FACTORY, USDC_ADDRESS, STETH_ADDRESS, WSTETH_ADDRESS, LDO_ADDRESS, STETH_ETH_CRV_POOL, WETH_ADDRESS, GNOSIS_EASY_AUCTION, WSTETH_PRICER, OptionsPremiumPricerInStables_BYTECODE, ManualVolOracle_BYTECODE, CHAINID, } from "./constants/constants";

import { deployProxy, setupOracle, setOpynOracleExpiryPriceYearn, getAssetPricer, whitelistProduct } from "./helpers/utils";
import * as time from "./helpers/time";
import { assert } from "./helpers/assertions";

import moment from "moment-timezone";

moment.tz.setDefault('UTC');

const { provider, getContractAt, getContractFactory, BigNumber, utils } = ethers;

const wethPriceOracleAddress = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const usdcPriceOracleAddress = "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6";

const DELAY_INCREMENT = 100;

describe("RibbonThetaSTETHVault - stETH (Call) - #completeWithdraw", () => {

  // Signers
  let adminSigner, userSigner, ownerSigner, keeperSigner, feeRecipientSigner;

  // Parameters
  let tokenName = "Ribbon ETH Theta Vault stETH";
  let tokenSymbol = "rSTETH-THETA";
  let tokenDecimals = 18;
  let minimumSupply = BigNumber.from("10").pow("10").toString();
  let chainId = network.config.chainId;
  let asset = WETH_ADDRESS[chainId];
  let strikeAsset = USDC_ADDRESS[chainId]
  let depositAsset = WETH_ADDRESS[chainId];
  let collateralAsset = WSTETH_ADDRESS[chainId];
  let intermediaryAsset = STETH_ADDRESS;
  let depositAmount = utils.parseEther("1");
  let premiumDiscount = BigNumber.from("997");
  let managementFee = BigNumber.from("2000000");
  let performanceFee = BigNumber.from("20000000");
  let stETHAmountAfterRounding = BigNumber.from("999746414674411972");
  let auctionDuration = 21600;
  let deltaStep = BigNumber.from("100");
  let deltaFirstOption = BigNumber.from("1000")
  let deltaSecondOption = BigNumber.from("1000")

  // Contracts
  let strikeSelection;
  let optionsPremiumPricer;
  let intermediaryAssetContract;
  let assetContract;
  let vault;

  const rollToNextOption = async () => {
    await vault.connect(ownerSigner).commitAndClose();
    const optionState = await vault.optionState();
    await time.increaseTo(optionState.nextOptionReadyAt + DELAY_INCREMENT);
    await strikeSelection.setDelta(deltaFirstOption);
    await vault.connect(keeperSigner).rollToNextOption();
  };

  const rollToSecondOption = async (settlementPrice) => {
    const oracle = await setupOracle(asset, CHAINLINK_WETH_PRICER_STETH, ownerSigner, OPTION_PROTOCOL.GAMMA);
    const expiry = await getCurrentOptionExpiry()
    const collateralPricerSigner = await getAssetPricer(WSTETH_PRICER, ownerSigner);
    await setOpynOracleExpiryPriceYearn(asset, oracle, settlementPrice, collateralPricerSigner, expiry);
    await strikeSelection.setDelta(deltaSecondOption);
    await vault.connect(ownerSigner).commitAndClose();
    await time.increaseTo((await vault.nextOptionReadyAt()).toNumber() + 1);
    await vault.connect(keeperSigner).rollToNextOption();
  };

  const getCurrentOptionExpiry = async () => {
    const currentOption = await vault.currentOption();
    const otoken = await getContractAt("IOtoken", currentOption);
    return otoken.expiryTimestamp();
  };

  before(async function () {

    [adminSigner, ownerSigner, keeperSigner, userSigner, feeRecipientSigner] = await ethers.getSigners();

    // setup oracle
    const TestVolOracle = await getContractFactory(ManualVolOracle_ABI, ManualVolOracle_BYTECODE, keeperSigner);
    const volOracle = await TestVolOracle.deploy(keeperSigner.address);
    const optionId = await volOracle.getOptionId(deltaStep, asset, collateralAsset, false);
    await volOracle.setAnnualizedVol([optionId], [106480000]);

    // increase timestamp
    const topOfPeriod = (await time.getTopOfPeriod()) + time.PERIOD;
    await time.increaseTo(topOfPeriod);

    // setup pricer
    const OptionsPremiumPricer = await getContractFactory(OptionsPremiumPricerInStables_ABI, OptionsPremiumPricerInStables_BYTECODE, ownerSigner);
    optionsPremiumPricer = await OptionsPremiumPricer.deploy(optionId, volOracle.address, wethPriceOracleAddress, usdcPriceOracleAddress);

    // setup strike selection
    const StrikeSelection = await getContractFactory("DeltaStrikeSelection", ownerSigner);
    strikeSelection = await StrikeSelection.deploy(optionsPremiumPricer.address, deltaFirstOption, BigNumber.from(deltaStep).mul(10 ** 8));

    // get libraries
    const VaultLifecycle = await ethers.getContractFactory("VaultLifecycle");
    const vaultLifecycleLib = await VaultLifecycle.deploy();
    const VaultLifecycleSTETH = await ethers.getContractFactory("VaultLifecycleSTETH");
    const vaultLifecycleSTETHLib = await VaultLifecycleSTETH.deploy();

    // deploy contract
    const options =[false, tokenDecimals, asset, asset, minimumSupply, utils.parseEther("500")];
    const initializeArgs = [ ownerSigner.address, keeperSigner.address, feeRecipientSigner.address, managementFee, performanceFee, 
      tokenName, tokenSymbol, optionsPremiumPricer.address, strikeSelection.address, premiumDiscount, auctionDuration, options];
    const deployArgs = [WETH_ADDRESS[chainId], USDC_ADDRESS[chainId], WSTETH_ADDRESS[chainId], LDO_ADDRESS, 
      OTOKEN_FACTORY[chainId], GAMMA_CONTROLLER[chainId], MARGIN_POOL[chainId], GNOSIS_EASY_AUCTION[chainId], STETH_ETH_CRV_POOL];
    const libs = { VaultLifecycle: vaultLifecycleLib.address, VaultLifecycleSTETH: vaultLifecycleSTETHLib.address };
    vault = (
      await deployProxy("RibbonThetaSTETHVault", adminSigner, initializeArgs, deployArgs, { libraries: libs })
    ).connect(userSigner);

    // whitelist product
    await whitelistProduct(asset, strikeAsset, collateralAsset, false, OPTION_PROTOCOL.GAMMA);

    // setup assets contracts
    assetContract = await getContractAt("IWETH", depositAsset);
    await assetContract.connect(userSigner).deposit({ value: utils.parseEther("100") });
    intermediaryAssetContract = await getContractAt("IERC20", intermediaryAsset);

  });

  it("completes the withdrawal", async function () {

    // deposit eth
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
    const firstOptionExpiry = moment(latestTimestamp * 1000).startOf("isoWeek").add(chainId === CHAINID.AVAX_MAINNET ? 0 : 1, "weeks").day("friday").hours(8).minutes(0).seconds(0).unix();
    const [firstOptionStrike] = await strikeSelection.getStrikePrice(firstOptionExpiry, false);
    const settlePriceITM = false ? firstOptionStrike.sub(100000000) : firstOptionStrike.add(100000000);
    await rollToSecondOption(settlePriceITM);
    const lastQueuedWithdrawAmount = await vault.lastQueuedWithdrawAmount();
    const beforeBalance = await intermediaryAssetContract.balanceOf(userSigner.address);
    const { queuedWithdrawShares: startQueuedShares } = await vault.vaultState();
    await vault.completeWithdraw({ gasPrice: utils.parseUnits("30", "gwei") });

    // check withdrawals
    const { shares, round } = await vault.withdrawals(userSigner.address);
    assert.equal(shares, 0);
    assert.equal(round, 2);

    // check shares
    const { queuedWithdrawShares: endQueuedShares } = await vault.vaultState();
    assert.bnEqual(endQueuedShares, BigNumber.from(0));
    assert.bnEqual(await vault.lastQueuedWithdrawAmount(), lastQueuedWithdrawAmount.sub(stETHAmountAfterRounding));
    assert.bnEqual(startQueuedShares.sub(endQueuedShares), depositAmount);

    // check balance and withdraw amount
    const afterBalance = await intermediaryAssetContract.balanceOf(userSigner.address);
    const actualWithdrawAmount = afterBalance.sub(beforeBalance);
    assert.bnLt(actualWithdrawAmount, depositAmount);
    assert.bnGte(actualWithdrawAmount.add(5), stETHAmountAfterRounding);
    assert.bnLte(actualWithdrawAmount, stETHAmountAfterRounding.add(5));
  });
});
