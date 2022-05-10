import { ethers, network } from "hardhat";
import { expect } from "chai";
import { BigNumber, BigNumberish, Contract } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import OptionsPremiumPricerInStables_ABI from "../abis/OptionsPremiumPricerInStables.json";
import ManualVolOracle_ABI from "../abis/ManualVolOracle.json";
import moment from "moment-timezone";
import * as time from "./helpers/time";
import {
  BLOCK_NUMBER,
  OPTION_PROTOCOL,
  CHAINLINK_WETH_PRICER_STETH,
  GAMMA_CONTROLLER,
  MARGIN_POOL,
  OTOKEN_FACTORY,
  USDC_ADDRESS,
  STETH_ADDRESS,
  WSTETH_ADDRESS,
  LDO_ADDRESS,
  STETH_ETH_CRV_POOL,
  WETH_ADDRESS,
  GNOSIS_EASY_AUCTION,
  WSTETH_PRICER,
  OptionsPremiumPricerInStables_BYTECODE,
  ManualVolOracle_BYTECODE,
  CHAINID,
} from "./constants/constants";
import {
  deployProxy,
  setupOracle,
  setOpynOracleExpiryPriceYearn,
  setAssetPricer,
  getAssetPricer,
  whitelistProduct,
  mintToken,
} from "./helpers/utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers";
import { assert } from "./helpers/assertions";

const { provider, getContractAt, getContractFactory } = ethers;
const { parseEther } = ethers.utils;

moment.tz.setDefault("UTC");

const DELAY_INCREMENT = 100;
const gasPrice = parseUnits("30", "gwei");

const wethPriceOracleAddress = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const wbtcPriceOracleAddress = "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c";
const usdcPriceOracleAddress = "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6";

const chainId = network.config.chainId;

describe("RibbonThetaSTETHVault", () => {
  behavesLikeRibbonOptionsVault({
    name: `Ribbon ETH Theta Vault - stETH (Call)`,
    tokenName: "Ribbon ETH Theta Vault stETH",
    tokenSymbol: "rSTETH-THETA",
    asset: WETH_ADDRESS[chainId],
    assetContractName: "IWETH",
    collateralContractName: "IWSTETH",
    strikeAsset: USDC_ADDRESS[chainId],
    collateralAsset: WSTETH_ADDRESS[chainId],
    intermediaryAsset: STETH_ADDRESS,
    depositAsset: WETH_ADDRESS[chainId],
    collateralPricer: WSTETH_PRICER,
    underlyingPricer: CHAINLINK_WETH_PRICER_STETH,
    deltaFirstOption: BigNumber.from("1000"),
    deltaSecondOption: BigNumber.from("1000"),
    deltaStep: BigNumber.from("100"),
    depositAmount: parseEther("1"),
    minimumSupply: BigNumber.from("10").pow("10").toString(),
    expectedMintAmount: BigNumber.from("93851929"),
    premiumDiscount: BigNumber.from("997"),
    managementFee: BigNumber.from("2000000"),
    performanceFee: BigNumber.from("20000000"),
    crvSlippage: BigNumber.from("1"),
    stETHAmountAfterRounding: BigNumber.from("999746414674411972"),
    auctionDuration: 21600,
    tokenDecimals: 18,
    isPut: false,
    gasLimits: {
      depositWorstCase: 173803,
      depositBestCase: 156881,
    },
  });
});

function behavesLikeRibbonOptionsVault(params: {
  name: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  asset: string;
  assetContractName: string;
  collateralContractName: string;
  depositAsset: string;
  strikeAsset: string;
  collateralAsset: string;
  intermediaryAsset: string;
  collateralPricer: string;
  underlyingPricer: string;
  deltaFirstOption: BigNumber;
  deltaSecondOption: BigNumber;
  deltaStep: BigNumber;
  depositAmount: BigNumber;
  minimumSupply: string;
  expectedMintAmount: BigNumber;
  auctionDuration: number;
  premiumDiscount: BigNumber;
  managementFee: BigNumber;
  performanceFee: BigNumber;
  crvSlippage: BigNumber;
  stETHAmountAfterRounding: BigNumber;
  isPut: boolean;
  gasLimits: {
    depositWorstCase: number;
    depositBestCase: number;
  };
  mintConfig?: {
    contractOwnerAddress: string;
  };
}) {
  // Addresses
  let owner: string, keeper: string, user: string, feeRecipient: string;

  // Signers
  let adminSigner: SignerWithAddress,
    userSigner: SignerWithAddress,
    ownerSigner: SignerWithAddress,
    keeperSigner: SignerWithAddress,
    feeRecipientSigner: SignerWithAddress;

  // Parameters
  let tokenName = params.tokenName;
  let tokenSymbol = params.tokenSymbol;
  let tokenDecimals = params.tokenDecimals;
  let minimumSupply = params.minimumSupply;
  let asset = params.asset;
  let depositAsset = params.depositAsset;
  let collateralAsset = params.collateralAsset;
  let intermediaryAsset = params.intermediaryAsset;
  let depositAmount = params.depositAmount;
  let premiumDiscount = params.premiumDiscount;
  let managementFee = params.managementFee;
  let performanceFee = params.performanceFee;
  let stETHAmountAfterRounding = params.stETHAmountAfterRounding;
  // let expectedMintAmount = params.expectedMintAmount;
  let auctionDuration = params.auctionDuration;
  let isPut = params.isPut;

  // Contracts
  let strikeSelection: Contract;
  let volOracle: Contract;
  let optionsPremiumPricer: Contract;
  let vaultLifecycleSTETHLib: Contract;
  let vaultLifecycleLib: Contract;
  let vault: Contract;
  let oTokenFactory: Contract;
  let assetContract: Contract;
  let intermediaryAssetContract: Contract;
  let collateralPricerSigner: Contract;

  // Variables
  let firstOptionStrike: BigNumber;
  let firstOptionExpiry: number;
  let optionId: string;

  describe(`${params.name}`, () => {

    const rollToNextOption = async () => {
      await vault.connect(ownerSigner).commitAndClose();
      await time.increaseTo((await getNextOptionReadyAt()) + DELAY_INCREMENT);
      await strikeSelection.setDelta(params.deltaFirstOption);
      await vault.connect(keeperSigner).rollToNextOption();
    };

    const rollToSecondOption = async (settlementPrice: BigNumber) => {
      const oracle = await setupOracle(
        params.asset,
        params.underlyingPricer,
        ownerSigner,
        OPTION_PROTOCOL.GAMMA
      );

      await setOpynOracleExpiryPriceYearn(
        params.asset,
        oracle,
        settlementPrice,
        collateralPricerSigner,
        await getCurrentOptionExpiry()
      );
      await strikeSelection.setDelta(params.deltaSecondOption);
      await vault.connect(ownerSigner).commitAndClose();
      await time.increaseTo((await vault.nextOptionReadyAt()).toNumber() + 1);
      await vault.connect(keeperSigner).rollToNextOption();
    };

    const getNextOptionReadyAt = async () => {
      const optionState = await vault.optionState();
      return optionState.nextOptionReadyAt;
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

      const TestVolOracle = await getContractFactory(
        ManualVolOracle_ABI,
        ManualVolOracle_BYTECODE,
        keeperSigner
      );

      volOracle = await TestVolOracle.deploy(keeper);

      optionId = await volOracle.getOptionId(
        params.deltaStep,
        asset,
        collateralAsset,
        isPut
      );

      await volOracle.setAnnualizedVol([optionId], [106480000]);

      const topOfPeriod = (await time.getTopOfPeriod()) + time.PERIOD;
      await time.increaseTo(topOfPeriod);

      const OptionsPremiumPricer = await getContractFactory(
        OptionsPremiumPricerInStables_ABI,
        OptionsPremiumPricerInStables_BYTECODE,
        ownerSigner
      );

      const StrikeSelection = await getContractFactory(
        "DeltaStrikeSelection",
        ownerSigner
      );

      optionsPremiumPricer = await OptionsPremiumPricer.deploy(
        optionId,
        volOracle.address,
        params.asset === WETH_ADDRESS[chainId]
          ? wethPriceOracleAddress
          : wbtcPriceOracleAddress,
        usdcPriceOracleAddress
      );

      strikeSelection = await StrikeSelection.deploy(
        optionsPremiumPricer.address,
        params.deltaFirstOption,
        BigNumber.from(params.deltaStep).mul(10 ** 8)
      );

      const VaultLifecycle = await ethers.getContractFactory("VaultLifecycle");
      vaultLifecycleLib = await VaultLifecycle.deploy();

      const VaultLifecycleSTETH = await ethers.getContractFactory(
        "VaultLifecycleSTETH"
      );
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
          isPut,
          tokenDecimals,
          isPut ? USDC_ADDRESS[chainId] : asset,
          asset,
          minimumSupply,
          parseEther("500"),
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

      oTokenFactory = await getContractAt(
        "IOtokenFactory",
        OTOKEN_FACTORY[chainId]
      );

      await whitelistProduct(
        params.asset,
        params.strikeAsset,
        params.collateralAsset,
        params.isPut,
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

      [firstOptionStrike] = await strikeSelection.getStrikePrice(
        firstOptionExpiry,
        params.isPut
      );

      const firstOptionAddress = await oTokenFactory.getTargetOtokenAddress(
        params.asset,
        params.strikeAsset,
        params.collateralAsset,
        firstOptionStrike,
        firstOptionExpiry,
        params.isPut
      );

      await strikeSelection.setDelta(params.deltaFirstOption);

      await vault.initRounds(50);

      assetContract = await getContractAt(
        params.assetContractName,
        depositAsset
      );

      intermediaryAssetContract = await getContractAt(
        "IERC20",
        intermediaryAsset
      );

      await setAssetPricer(
        collateralAsset,
        params.collateralPricer,
        OPTION_PROTOCOL.GAMMA
      );

      collateralPricerSigner = await getAssetPricer(
        params.collateralPricer,
        ownerSigner
      );

      // If mintable token, then mine the token
      if (params.mintConfig) {
        const addressToDeposit = [userSigner, ownerSigner, adminSigner];

        for (let i = 0; i < addressToDeposit.length; i++) {
          await mintToken(
            assetContract,
            params.mintConfig.contractOwnerAddress,
            addressToDeposit[i].address,
            vault.address,
            params.depositAsset === USDC_ADDRESS[chainId]
              ? BigNumber.from("10000000000000")
              : parseEther("200")
          );
        }
      } else if (params.asset === WETH_ADDRESS[chainId]) {
        await assetContract
          .connect(userSigner)
          .deposit({ value: parseEther("100") });
      }
    });

    describe("#completeWithdraw", () => {
      time.revertToSnapshotAfterEach(async () => {
        await assetContract
          .connect(userSigner)
          .approve(vault.address, params.depositAmount);

        await depositIntoVault(
          params.depositAsset,
          vault,
          params.depositAmount
        );

        await assetContract.connect(userSigner).transfer(owner, depositAmount);
        await assetContract
          .connect(ownerSigner)
          .approve(vault.address, depositAmount);
        await vault.connect(ownerSigner).depositETH({ value: depositAmount });

        await rollToNextOption();

        await vault.initiateWithdraw(depositAmount);
      });

      it("completes the withdrawal", async function () {
        const firstStrikePrice = firstOptionStrike;
        const settlePriceITM = isPut
          ? firstStrikePrice.sub(100000000)
          : firstStrikePrice.add(100000000);

        await rollToSecondOption(settlePriceITM);

        const lastQueuedWithdrawAmount = await vault.lastQueuedWithdrawAmount();

        const beforeBalance: BigNumber =
          await intermediaryAssetContract.balanceOf(user);

        const { queuedWithdrawShares: startQueuedShares } =
          await vault.vaultState();

        const tx = await vault.completeWithdraw({ gasPrice });

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

        const { queuedWithdrawShares: endQueuedShares } =
          await vault.vaultState();

        assert.bnEqual(endQueuedShares, BigNumber.from(0));
        assert.bnEqual(
          await vault.lastQueuedWithdrawAmount(),
          lastQueuedWithdrawAmount.sub(stETHAmountAfterRounding)
        );
        assert.bnEqual(startQueuedShares.sub(endQueuedShares), depositAmount);

        const afterBalance = await intermediaryAssetContract.balanceOf(user);
        const actualWithdrawAmount: BigNumber = afterBalance.sub(beforeBalance);

        // Should be less because the pps is down
        assert.bnLt(actualWithdrawAmount, depositAmount);
        // Account for rounding when minting stETH
        assert.bnGte(actualWithdrawAmount.add(5), stETHAmountAfterRounding);
        assert.bnLte(actualWithdrawAmount, stETHAmountAfterRounding.add(5));
      });

    });
  });
}

async function depositIntoVault(
  asset: string,
  vault: Contract,
  amount: BigNumberish,
  signer?: SignerWithAddress
) {
  if (typeof signer !== "undefined") {
    vault = vault.connect(signer);
  }
  await vault.depositETH({ value: amount });
}
