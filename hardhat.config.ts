import "@nomiclabs/hardhat-waffle";
import "@nomiclabs/hardhat-ethers";

require("dotenv").config();

export default {
  solidity: {
    version: "0.8.4",
    settings: {
      optimizer: {
        runs: 200,
        enabled: true,
      },
    },
  },
  networks: {
    hardhat: {
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
      },
      chainId: 1,
      forking: {
        url: process.env.TEST_URI,
        blockNumber: 14448950,
        gasLimit: 8e6,
      },
    },
  },
  namedAccounts: {
    deployer: {
      default: 0,
      1: "0x422f7Bb366608723c8fe61Ac6D923023dCCBC3d7",
    },
    owner: {
      default: 0,
      1: "0xAb6df2dE75a4f07D95c040DF90c7362bB5edcd90",
    },
    keeper: {
      default: 0,
      1: "0xAb6df2dE75a4f07D95c040DF90c7362bB5edcd90",
    },
    admin: {
      default: 0,
      1: "0x88A9142fa18678003342a8Fd706Bd301E0FecEfd",
    },
    feeRecipient: {
      default: 0,
      1: "0xDAEada3d210D2f45874724BeEa03C7d4BBD41674", // Ribbon DAO
    },
  },
  mocha: {
    timeout: 500000,
  },
};
