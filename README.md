# Odyssey DEX presale contracts (whitepaper v1.2)

## STATUS: NOT compiled, NOT tested, NOT audited
This code was written without access to a Solidity compiler. Compile and run the tests first
(`npm install && npx hardhat test`), expect to fix small errors, and get an independent audit
before any mainnet deployment. Contracts that hold user money cannot be patched after launch.

## Contracts
- `OdysseyToken.sol`: ERC-20, 1.5B fixed mint, burn, permit, votes. No owner, no fees, no pause.
- `OdysseyPresale.sol`: 17 rounds ($0.008 to $0.07), ETH/USDC/USDT, min $80, max $2,000 per wallet,
  max $700 per round in rounds 1-5, partial fill with excess returned, unsold burned, claim 40% / 70% (30 days) / 100% (90 days),
  70% of proceeds withdrawable by anyone to the treasury multisig, 30% liquidity share released only by the multisig.
- `OdysseyVesting.sol`: linear vesting that starts at presale end + cliff (team, DAO treasury, strategic, advisors).
- `mocks/`: test and testnet only.

## Where the code differs from the whitepaper (update the text or the code)
1. Price-feed age: ETH 2 hours (whitepaper says 1 hour; the ETH/USD feed's own heartbeat is 1 hour, so a 1-hour limit fails often).
   Stablecoin feeds 25 hours (their heartbeat is 24 hours). Stablecoins are credited at min(feed price, $1).
2. Purchases above a wallet or round limit revert; they are not partially filled. Only the "round sold out" case is partially filled.
3. The 30% liquidity share goes to `liquidityWallet` when the treasury multisig calls `releaseLiquidity`. The contract cannot force
   that wallet to use it only for the pool. That stays a public commitment.
4. Months are 30 days (cliff 180 days). The security reserve (6%) and ecosystem/airdrop (25%) are sent to wallets you control
   (use a multisig); the airdrop distribution (e.g. a Merkle claim contract) is not included.
5. Presale start is a fixed timestamp in the constructor. Tokens must be in the contract before the start, or purchases revert.

## Programs you need
Node.js 20+, Hardhat, OpenZeppelin Contracts 5, a code editor, Git.
MetaMask or a hardware wallet (Ledger/Trezor), a Safe multisig (app.safe.global), an RPC provider (Alchemy or Infura),
an Etherscan API key, test ETH from a Sepolia faucet. For the website: a web3 library (ethers or wagmi), WalletConnect project ID, hosting.
Monitoring (Tenderly or OpenZeppelin Defender-style alerts) and an audit firm.

## Order of work
1. `npm install`, `npx hardhat test`, fix errors.
2. Create the Safe multisig (4 of 7, 2 independent signers). Prepare all wallets in `.env`.
3. Deploy to Sepolia (`npm run deploy:sepolia`), test every flow with several wallets, test round timeouts.
4. Audit. Publish the report. Apply fixes and re-audit changes.
5. Check every mainnet address in `scripts/deploy.js` against Chainlink and Etherscan.
6. Deploy to mainnet with a dedicated deployer wallet, verify source on Etherscan, publish all addresses.
7. Start with the presale start time far enough away to check the funded balance (300M ODX in the presale contract) before it opens.
8. Legal review and geo-restriction before opening to the public.

Never put private keys in the repo or share them with anyone.
