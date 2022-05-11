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
      chainId: 1,
      forking: {
        url: process.env.TEST_URI,
        blockNumber: 14448950,
        gasLimit: 8e6,
      },
    },
  },
};
