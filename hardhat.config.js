require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const accounts = process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [];

// Mainnet fork for tests: only when FORK=1 (see test/fork.mainnet.test.js)
let hardhatNetwork = {};
if (process.env.FORK === "1") {
  if (!process.env.MAINNET_RPC_URL) throw new Error("FORK=1 needs MAINNET_RPC_URL in .env");
  hardhatNetwork = { forking: { url: process.env.MAINNET_RPC_URL } };
  if (process.env.FORK_BLOCK) hardhatNetwork.forking.blockNumber = Number(process.env.FORK_BLOCK);
}

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: hardhatNetwork,
    sepolia: { url: process.env.SEPOLIA_RPC_URL || "", accounts },
    mainnet: { url: process.env.MAINNET_RPC_URL || "", accounts },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "sepolia",
        chainId: 11155111,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=11155111",
          browserURL: "https://sepolia.etherscan.io",
        },
      },
    ],
  },
};