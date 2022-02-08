import { ethers, network } from "hardhat";
import { Contract } from "ethers";
import moment from "moment-timezone";
import { assert } from "../helpers/assertions";
import * as time from "../helpers/time";
import { parseEther } from "ethers/lib/utils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers";
import { expect } from "chai";
import { STETH_ADDRESS, WSTETH_ADDRESS } from "../../constants/constants";

moment.tz.setDefault("UTC");

const chainId = network.config.chainId;

// const provider = ethers.provider;
// const gasPrice = parseUnits("1", "gwei");

describe("VaultLifecycleSTETH", () => {
  let lifecycle: Contract;
  let signer: SignerWithAddress;
  let stETH: Contract;
  let wstETH: Contract;
  // let crv: Contract;

  beforeEach(async () => {
    [signer] = await ethers.getSigners();

    const VaultLifecycle = await ethers.getContractFactory(
      "VaultLifecycleSTETH"
    );
    const lifecycleLib = await VaultLifecycle.deploy();

    const TestVaultLifecycle = await ethers.getContractFactory(
      "TestVaultLifecycleSTETH",
      { libraries: { VaultLifecycleSTETH: lifecycleLib.address } }
    );
    lifecycle = await TestVaultLifecycle.deploy();
    lifecycle = lifecycle.connect(signer);

    stETH = await ethers.getContractAt("ISTETH", STETH_ADDRESS, signer);
    wstETH = await ethers.getContractAt(
      "IWSTETH",
      WSTETH_ADDRESS[chainId],
      signer
    );
    // crv = await ethers.getContractAt("ICRV", STETH_ETH_CRV_POOL, signer);
  });

  describe("unwrapYieldToken", () => {
    time.revertToSnapshotAfterEach();

    it("returns the full amount if balance is >= amount", async () => {
      await signer.sendTransaction({
        to: lifecycle.address,
        value: parseEther("1"),
      });

      await lifecycle.unwrapYieldToken(parseEther("1"), parseEther("1"));

      expect(await lifecycle.output()).to.equals(parseEther("1"));
    });

    it("reverts if amount < minETHOut", async () => {
      await signer.sendTransaction({
        to: lifecycle.address,
        value: parseEther("1"),
      });

      await expect(
        lifecycle.unwrapYieldToken(parseEther("0.9"), parseEther("1"))
      ).to.be.revertedWith("Amount withdrawn smaller than minETHOut from swap");
    });

    it("performs a swap when there is existing ETH + stETH balance", async () => {
      // only 0.5 on contract so we need to swap 0.5
      await signer.sendTransaction({
        to: lifecycle.address,
        value: parseEther("0.5"),
      });

      await stETH.submit(signer.address, { value: parseEther("0.5") });

      await stETH.transfer(lifecycle.address, parseEther("0.5"));

      await lifecycle.unwrapYieldToken(
        parseEther("1"),
        parseEther("0.995") // 0.5% slippage
      );

      assert.bnGte(await lifecycle.output(), parseEther("0.995"));
    });

    it("performs a swap when there is existing stETH balance", async () => {
      await stETH.submit(signer.address, { value: parseEther("1") });

      await stETH.transfer(lifecycle.address, parseEther("1"));

      await lifecycle.unwrapYieldToken(
        parseEther("1"),
        parseEther("0.995") // 0.5% slippage
      );

      assert.bnGte(await lifecycle.output(), parseEther("0.995"));
    });

    it("performs a swap when there is existing ETH + wstETH balance", async () => {
      // only 0.5 on contract so we need to swap 0.5
      await signer.sendTransaction({
        to: lifecycle.address,
        value: parseEther("0.5"),
      });

      await stETH.submit(signer.address, { value: parseEther("0.5") });

      await stETH.approve(wstETH.address, parseEther("0.5"));

      await wstETH.wrap(parseEther("0.5"));

      await wstETH.transfer(
        lifecycle.address,
        await wstETH.balanceOf(signer.address)
      );

      await lifecycle.unwrapYieldToken(
        parseEther("1"),
        parseEther("0.995") // 0.5% slippage
      );

      assert.bnGte(await lifecycle.output(), parseEther("0.995"));
    });

    it("performs a swap when there is existing wstETH balance", async () => {
      await stETH.submit(signer.address, { value: parseEther("1") });

      await stETH.approve(wstETH.address, parseEther("1"));

      await wstETH.wrap(parseEther("1"));

      await wstETH.transfer(
        lifecycle.address,
        await wstETH.balanceOf(signer.address)
      );

      await lifecycle.unwrapYieldToken(
        parseEther("1"),
        parseEther("0.995") // 0.5% slippage
      );

      assert.bnGte(await lifecycle.output(), parseEther("0.995"));
    });

    it("reverts when slippage is too low", async () => {
      await stETH.submit(signer.address, { value: parseEther("1") });

      await stETH.approve(wstETH.address, parseEther("1"));

      await wstETH.wrap(parseEther("1"));

      await wstETH.transfer(
        lifecycle.address,
        await wstETH.balanceOf(signer.address)
      );

      await expect(
        lifecycle.unwrapYieldToken(
          parseEther("1"),
          parseEther("0.999") // 0.5% slippage
        )
      ).to.be.revertedWith("Output ETH amount smaller than minETHOut");
    });

    it("reverts when minETHOut is larger than amount", async () => {
      await expect(
        lifecycle.unwrapYieldToken(parseEther("1"), parseEther("1.001"))
      ).to.be.revertedWith("Amount withdrawn smaller than minETHOut from swap");
    });

    it("reverts when minETHOut is <0.95 of the amount", async () => {
      await expect(
        lifecycle.unwrapYieldToken(parseEther("1"), parseEther("0.949"))
      ).to.be.revertedWith("Slippage on minETHOut too high");
    });
  });

  describe("withdrawStEth", () => {
    time.revertToSnapshotAfterEach();

    it("withdraws stETH", async () => {
      const withdrawAmount = parseEther("1");
      await stETH.connect(signer).submit(signer.address, {
        value: withdrawAmount,
      });
      const stETHBalance = await stETH.balanceOf(signer.address);
      await stETH.connect(signer).transfer(lifecycle.address, stETHBalance);

      const halfWithdrawAmount = withdrawAmount.div(2);
      await lifecycle.withdrawStEth(halfWithdrawAmount);
      let output = await lifecycle.output();
      assert.bnGte(output.add(3), halfWithdrawAmount);
      assert.bnLte(output, halfWithdrawAmount.add(3));
      await lifecycle.withdrawStEth(halfWithdrawAmount);
      output = await lifecycle.output();
      assert.bnGte(output.add(3), halfWithdrawAmount);
      assert.bnLte(output, halfWithdrawAmount.add(3));
    });

    it("withdraws wstETH", async () => {
      const withdrawAmount = parseEther("1");
      await stETH
        .connect(signer)
        .submit(signer.address, { value: withdrawAmount });
      const stETHBalance = await stETH.balanceOf(signer.address);
      await stETH.connect(signer).approve(wstETH.address, stETHBalance);
      await wstETH.connect(signer).wrap(stETHBalance);
      await wstETH
        .connect(signer)
        .transfer(lifecycle.address, await wstETH.balanceOf(signer.address));

      const halfWithdrawAmount = withdrawAmount.div(2);
      await lifecycle.withdrawStEth(halfWithdrawAmount);
      let output = await lifecycle.output();
      assert.bnGte(output.add(3), halfWithdrawAmount);
      assert.bnLte(output, halfWithdrawAmount.add(3));
      await lifecycle.withdrawStEth(halfWithdrawAmount);
      output = await lifecycle.output();
      assert.bnGte(output.add(3), halfWithdrawAmount);
      assert.bnLte(output, halfWithdrawAmount.add(3));
    });

    it("withdraws ETH", async () => {
      const withdrawAmount = parseEther("1");

      await signer.sendTransaction({
        to: lifecycle.address,
        value: withdrawAmount,
      });

      const halfWithdrawAmount = withdrawAmount.div(2);
      await lifecycle.withdrawStEth(halfWithdrawAmount);
      let output = await lifecycle.output();
      assert.bnGte(output.add(3), halfWithdrawAmount);
      assert.bnLte(output, halfWithdrawAmount.add(3));
      await lifecycle.withdrawStEth(halfWithdrawAmount);
      output = await lifecycle.output();
      assert.bnGte(output.add(3), halfWithdrawAmount);
      assert.bnLte(output, halfWithdrawAmount.add(3));
    });

    it("withdraws stETH + wstETH", async () => {
      const withdrawAmount = parseEther("1");
      const halfWithdrawAmount = withdrawAmount.div(2);
      await stETH
        .connect(signer)
        .submit(signer.address, { value: withdrawAmount });
      await stETH.connect(signer).approve(wstETH.address, halfWithdrawAmount);
      await wstETH.connect(signer).wrap(halfWithdrawAmount);
      await stETH
        .connect(signer)
        .transfer(lifecycle.address, await stETH.balanceOf(signer.address));
      await wstETH
        .connect(signer)
        .transfer(lifecycle.address, await wstETH.balanceOf(signer.address));

      await lifecycle.withdrawStEth(withdrawAmount);
      let output = await lifecycle.output();
      assert.bnGte(output.add(3), withdrawAmount);
      assert.bnLte(output, withdrawAmount.add(3));
    });

    it("withdraws stETH + ETH", async () => {
      const withdrawAmount = parseEther("1");
      const halfWithdrawAmount = withdrawAmount.div(2);
      await signer.sendTransaction({
        to: lifecycle.address,
        value: halfWithdrawAmount,
      });
      await stETH.connect(signer).submit(signer.address, {
        value: halfWithdrawAmount,
      });
      const stETHBalance = await stETH.balanceOf(signer.address);
      await stETH.connect(signer).transfer(lifecycle.address, stETHBalance);

      await lifecycle.withdrawStEth(withdrawAmount);
      let output = await lifecycle.output();
      assert.bnGte(output.add(3), withdrawAmount);
      assert.bnLte(output, withdrawAmount.add(3));
    });

    it("withdraws wstETH + ETH", async () => {
      const withdrawAmount = parseEther("1");
      const halfWithdrawAmount = withdrawAmount.div(2);
      await signer.sendTransaction({
        to: lifecycle.address,
        value: halfWithdrawAmount,
      });
      await stETH
        .connect(signer)
        .submit(signer.address, { value: halfWithdrawAmount });
      await stETH.connect(signer).approve(wstETH.address, halfWithdrawAmount);
      await wstETH.connect(signer).wrap(halfWithdrawAmount);
      await stETH
        .connect(signer)
        .transfer(lifecycle.address, await stETH.balanceOf(signer.address));
      await wstETH
        .connect(signer)
        .transfer(lifecycle.address, await wstETH.balanceOf(signer.address));

      await lifecycle.withdrawStEth(withdrawAmount);
      let output = await lifecycle.output();
      assert.bnGte(output.add(3), withdrawAmount);
      assert.bnLte(output, withdrawAmount.add(3));
    });

    it("withdraws stETH + wstETH + ETH", async () => {
      const withdrawAmount = parseEther("1");
      const thirdWithdrawAmount = withdrawAmount.div(3);
      await signer.sendTransaction({
        to: lifecycle.address,
        value: thirdWithdrawAmount,
      });
      await stETH
        .connect(signer)
        .submit(signer.address, {
          value: withdrawAmount.sub(thirdWithdrawAmount),
        });
      await stETH.connect(signer).approve(wstETH.address, thirdWithdrawAmount);
      await wstETH.connect(signer).wrap(thirdWithdrawAmount);
      await stETH
        .connect(signer)
        .transfer(lifecycle.address, await stETH.balanceOf(signer.address));
      await wstETH
        .connect(signer)
        .transfer(lifecycle.address, await wstETH.balanceOf(signer.address));

      await lifecycle.withdrawStEth(withdrawAmount);
      let output = await lifecycle.output();
      assert.bnGte(output.add(3), withdrawAmount);
      assert.bnLte(output, withdrawAmount.add(3));
    });
  });
});
