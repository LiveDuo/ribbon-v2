require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");

require("dotenv").config();

module.exports = {
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
      chainId: 1,
      forking: {
        url: process.env.TEST_URI,
        gasLimit: 8e6,
      },
    },
  },
  mocha: {
    timeout: 180000
  }
};
