import { ethers, network } from "hardhat";
import { expect } from "chai";

import OptionsPremiumPricerInStables_ABI from "../abis/OptionsPremiumPricerInStables.json";
import ManualVolOracle_ABI from "../abis/ManualVolOracle.json";

import { BLOCK_NUMBER, OPTION_PROTOCOL, CHAINLINK_WETH_PRICER_STETH, GAMMA_CONTROLLER, MARGIN_POOL, OTOKEN_FACTORY, USDC_ADDRESS, STETH_ADDRESS, WSTETH_ADDRESS, LDO_ADDRESS, STETH_ETH_CRV_POOL, WETH_ADDRESS, GNOSIS_EASY_AUCTION, WSTETH_PRICER, OptionsPremiumPricerInStables_BYTECODE, ManualVolOracle_BYTECODE, CHAINID, } from "./constants/constants";

import { deployProxy, setupOracle, setOpynOracleExpiryPriceYearn, setAssetPricer, getAssetPricer, whitelistProduct } from "./helpers/utils";
import * as time from "./helpers/time";
import { assert } from "./helpers/assertions";

import moment from "moment-timezone";

moment.tz.setDefault('UTC');

const { provider, getContractAt, getContractFactory, BigNumber, utils } = ethers;

const wethPriceOracleAddress = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const wbtcPriceOracleAddress = "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c";
const usdcPriceOracleAddress = "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6";

const DELAY_INCREMENT = 100;

describe("RibbonThetaSTETHVault - stETH (Call) - #completeWithdraw", () => {
  
  // Addresses
  let owner, keeper, user, feeRecipient;

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
  let volOracle;
  let optionsPremiumPricer;
  let vaultLifecycleSTETHLib;
  let vaultLifecycleLib;
  let vault;
  let assetContract;
  let intermediaryAssetContract;
  let collateralPricerSigner;

  // Variables
  let firstOptionStrike;
  let firstOptionExpiry;
  let optionId;

  const rollToNextOption = async () => {
    await vault.connect(ownerSigner).commitAndClose();
    const optionState = await vault.optionState();
    await time.increaseTo(optionState.nextOptionReadyAt + DELAY_INCREMENT);
    await strikeSelection.setDelta(deltaFirstOption);
    await vault.connect(keeperSigner).rollToNextOption();
  };

  const rollToSecondOption = async (settlementPrice) => {
    const oracle = await setupOracle(
      asset,
      CHAINLINK_WETH_PRICER_STETH,
      ownerSigner,
      OPTION_PROTOCOL.GAMMA
    );

    await setOpynOracleExpiryPriceYearn(
      asset,
      oracle,
      settlementPrice,
      collateralPricerSigner,
      await getCurrentOptionExpiry()
    );
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
    // Reset block
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.TEST_URI,
            blockNumber: BLOCK_NUMBER[chainId],
          },
        },
      ],
    });

    [adminSigner, ownerSigner, keeperSigner, userSigner, feeRecipientSigner] =
      await ethers.getSigners();
    owner = ownerSigner.address;
    user = userSigner.address;
    keeper = keeperSigner.address;
    feeRecipient = feeRecipientSigner.address;

    const TestVolOracle = await getContractFactory(ManualVolOracle_ABI, ManualVolOracle_BYTECODE, keeperSigner);

    volOracle = await TestVolOracle.deploy(keeper);

    optionId = await volOracle.getOptionId(
      deltaStep,
      asset,
      collateralAsset,
      false
    );

    await volOracle.setAnnualizedVol([optionId], [106480000]);

    const topOfPeriod = (await time.getTopOfPeriod()) + time.PERIOD;
    await time.increaseTo(topOfPeriod);

    const OptionsPremiumPricer = await getContractFactory(
      OptionsPremiumPricerInStables_ABI,
      OptionsPremiumPricerInStables_BYTECODE,
      ownerSigner
    );

    const StrikeSelection = await getContractFactory("DeltaStrikeSelection", ownerSigner);

    optionsPremiumPricer = await OptionsPremiumPricer.deploy(
      optionId,
      volOracle.address,
      asset === WETH_ADDRESS[chainId]
        ? wethPriceOracleAddress
        : wbtcPriceOracleAddress,
      usdcPriceOracleAddress
    );

    strikeSelection = await StrikeSelection.deploy(
      optionsPremiumPricer.address,
      deltaFirstOption,
      BigNumber.from(deltaStep).mul(10 ** 8)
    );

    const VaultLifecycle = await ethers.getContractFactory("VaultLifecycle");
    vaultLifecycleLib = await VaultLifecycle.deploy();

    const VaultLifecycleSTETH = await ethers.getContractFactory("VaultLifecycleSTETH");
    vaultLifecycleSTETHLib = await VaultLifecycleSTETH.deploy();

    const initializeArgs = [
      owner,
      keeper,
      feeRecipient,
      managementFee,
      performanceFee,
      tokenName,
      tokenSymbol,
      optionsPremiumPricer.address,
      strikeSelection.address,
      premiumDiscount,
      auctionDuration,
      [
        false,
        tokenDecimals,
        false ? USDC_ADDRESS[chainId] : asset,
        asset,
        minimumSupply,
        utils.parseEther("500"),
      ],
    ];

    const deployArgs = [
      WETH_ADDRESS[chainId],
      USDC_ADDRESS[chainId],
      WSTETH_ADDRESS[chainId],
      LDO_ADDRESS,
      OTOKEN_FACTORY[chainId],
      GAMMA_CONTROLLER[chainId],
      MARGIN_POOL[chainId],
      GNOSIS_EASY_AUCTION[chainId],
      STETH_ETH_CRV_POOL,
    ];

    vault = (
      await deployProxy(
        "RibbonThetaSTETHVault",
        adminSigner,
        initializeArgs,
        deployArgs,
        {
          libraries: {
            VaultLifecycle: vaultLifecycleLib.address,
            VaultLifecycleSTETH: vaultLifecycleSTETHLib.address,
          },
        }
      )
    ).connect(userSigner);

    await whitelistProduct(
      asset,
      strikeAsset,
      collateralAsset,
      false,
      OPTION_PROTOCOL.GAMMA
    );

    const latestTimestamp = (await provider.getBlock("latest")).timestamp;

    // Create first option
    firstOptionExpiry = moment(latestTimestamp * 1000)
      .startOf("isoWeek")
      .add(chainId === CHAINID.AVAX_MAINNET ? 0 : 1, "weeks")
      .day("friday")
      .hours(8)
      .minutes(0)
      .seconds(0)
      .unix();

    [firstOptionStrike] = await strikeSelection.getStrikePrice(firstOptionExpiry, false);

    await strikeSelection.setDelta(deltaFirstOption);

    await vault.initRounds(50);

    assetContract = await getContractAt("IWETH", depositAsset);

    intermediaryAssetContract = await getContractAt("IERC20", intermediaryAsset);

    await setAssetPricer(collateralAsset, WSTETH_PRICER, OPTION_PROTOCOL.GAMMA);

    collateralPricerSigner = await getAssetPricer(WSTETH_PRICER, ownerSigner);

    await assetContract.connect(userSigner).deposit({ value: utils.parseEther("100") });

  });

  it("completes the withdrawal", async function () {

    await assetContract.connect(userSigner).approve(vault.address, depositAmount);

    await vault.depositETH({ value: depositAmount });

    await assetContract.connect(userSigner).transfer(owner, depositAmount);
    await assetContract.connect(ownerSigner).approve(vault.address, depositAmount);
    await vault.connect(ownerSigner).depositETH({ value: depositAmount });

    await rollToNextOption();

    await vault.initiateWithdraw(depositAmount);

    const firstStrikePrice = firstOptionStrike;
    const settlePriceITM = false ? firstStrikePrice.sub(100000000) : firstStrikePrice.add(100000000);

    await rollToSecondOption(settlePriceITM);

    const lastQueuedWithdrawAmount = await vault.lastQueuedWithdrawAmount();

    const beforeBalance = await intermediaryAssetContract.balanceOf(user);

    const { queuedWithdrawShares: startQueuedShares } = await vault.vaultState();

    const tx = await vault.completeWithdraw({ gasPrice: utils.parseUnits("30", "gwei") });

    await expect(tx)
      .to.emit(vault, "Withdraw")
      .withArgs(user, stETHAmountAfterRounding.toString(), depositAmount);

    if (depositAsset !== WETH_ADDRESS[chainId]) {
      const collateralERC20 = await getContractAt("IERC20", depositAsset);

      await expect(tx)
        .to.emit(collateralERC20, "Transfer")
        .withArgs(vault.address, user, stETHAmountAfterRounding);
    }

    const { shares, round } = await vault.withdrawals(user);
    assert.equal(shares, 0);
    assert.equal(round, 2);

    const { queuedWithdrawShares: endQueuedShares } = await vault.vaultState();

    assert.bnEqual(endQueuedShares, BigNumber.from(0));
    assert.bnEqual(
      await vault.lastQueuedWithdrawAmount(),
      lastQueuedWithdrawAmount.sub(stETHAmountAfterRounding)
    );
    assert.bnEqual(startQueuedShares.sub(endQueuedShares), depositAmount);

    const afterBalance = await intermediaryAssetContract.balanceOf(user);
    const actualWithdrawAmount = afterBalance.sub(beforeBalance);

    // Should be less because the pps is down
    assert.bnLt(actualWithdrawAmount, depositAmount);
    // Account for rounding when minting stETH
    assert.bnGte(actualWithdrawAmount.add(5), stETHAmountAfterRounding);
    assert.bnLte(actualWithdrawAmount, stETHAmountAfterRounding.add(5));
  });
});
