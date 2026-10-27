// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IBurnable {
    function burn(uint256 amount) external;
}

interface IAggregator {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title Odyssey DEX presale (whitepaper v1.4)
/// 17 rounds, $0.008 -> $0.07, pay with ETH/USDC/USDT, no owner, no pause, no refunds.
/// Every payment is forwarded to the treasury in the same transaction. This contract never holds buyer funds.
/// Buyers pass a minimum number of tokens (minTokens) so a round change cannot give them fewer tokens than expected.
/// Rules cannot be changed after deployment. NOT AUDITED: do not use on mainnet before an audit.
contract OdysseyPresale is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---- fixed rules ----
    uint256 public constant ROUNDS = 17;
    uint256 public constant ROUND_DURATION = 12 days;
    uint256 public constant TOTAL_FOR_SALE = 300_000_000 ether;
    uint256 public constant PER_ROUND = TOTAL_FOR_SALE / ROUNDS; // last round gets the remainder
    uint256 public constant MIN_PURCHASE_USD = 80 ether; // USD, 18 decimals
    uint256 public constant MAX_PER_WALLET_USD = 2_000 ether;
    uint256 public constant EARLY_ROUNDS = 5; // rounds 1-5 (index 0-4)
    uint256 public constant MAX_PER_ROUND_EARLY_USD = 700 ether;
    uint256 public constant ETH_MAX_AGE = 2 hours; // ETH/USD heartbeat is 1h
    uint256 public constant STABLE_MAX_AGE = 25 hours; // stablecoin feeds have a 24h heartbeat

    struct Config {
        address token;
        address treasury; // receives 100% of every payment, immediately
        uint256 startTime;
        address usdc;
        address usdt;
        address ethUsdFeed;
        address usdcUsdFeed;
        address usdtUsdFeed;
    }

    IERC20 public immutable token;
    address public immutable treasury;
    uint256 public immutable startTime;
    address public immutable usdc;
    address public immutable usdt;
    IAggregator public immutable ethUsdFeed;
    IAggregator public immutable usdcUsdFeed;
    IAggregator public immutable usdtUsdFeed;

    // ---- state ----
    // NOTE: round and roundStart are only written when someone buys or finalizes, so they can lag behind time.
    // Use saleState() for the real current round.
    uint256 public round; // stored round index (may lag behind time, see _roundState)
    uint256 public roundStart;
    uint256 public endTime; // set when the last round sells out; otherwise derived from time
    uint256 public totalSold;
    bool public finalized;

    mapping(uint256 => uint256) public roundSold;
    mapping(address => uint256) public purchased;
    mapping(address => uint256) public claimed;
    mapping(address => uint256) public spentUsd;
    mapping(address => mapping(uint256 => uint256)) public spentInRound;

    event Purchased(address indexed buyer, address indexed asset, uint256 paid, uint256 usdValue, uint256 tokens, uint256 round);
    event Claimed(address indexed buyer, uint256 amount);
    event Finalized(uint256 endTime, uint256 burned);

    constructor(Config memory c) {
        require(
            c.token != address(0) && c.treasury != address(0) &&
            c.usdc != address(0) && c.usdt != address(0),
            "zero address"
        );
        require(c.startTime >= block.timestamp, "start in past");
        require(IERC20Metadata(c.usdc).decimals() == 6 && IERC20Metadata(c.usdt).decimals() == 6, "stable decimals");
        require(
            IAggregator(c.ethUsdFeed).decimals() == 8 && IAggregator(c.usdcUsdFeed).decimals() == 8 &&
            IAggregator(c.usdtUsdFeed).decimals() == 8,
            "feed decimals"
        );
        token = IERC20(c.token);
        treasury = c.treasury;
        startTime = c.startTime;
        usdc = c.usdc;
        usdt = c.usdt;
        ethUsdFeed = IAggregator(c.ethUsdFeed);
        usdcUsdFeed = IAggregator(c.usdcUsdFeed);
        usdtUsdFeed = IAggregator(c.usdtUsdFeed);
        roundStart = c.startTime;
    }

    // ---------------------------------------------------------------- buying

    /// @param minTokens the least ODX the buyer accepts. The purchase reverts with "slippage" if it would give fewer
    /// (for example because the round ended and the next round has a higher price). Use 0 for no protection.
    /// The amount actually used goes straight to the treasury. Any excess is refunded to the buyer.
    function buyWithETH(uint256 minTokens) external payable nonReentrant {
        uint256 usd18 = Math.mulDiv(msg.value, _feedPrice(ethUsdFeed, ETH_MAX_AGE), 1e8);
        uint256 used = _buy(address(0), msg.value, usd18, minTokens);
        (bool sent, ) = treasury.call{value: used}("");
        require(sent, "treasury transfer failed");
        uint256 refund = msg.value - used;
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            require(ok, "refund failed");
        }
    }

    /// @param asset USDC or USDT. Approve this contract first. Only the amount actually used is pulled,
    /// and it goes straight from the buyer to the treasury.
    /// @param minTokens the least ODX the buyer accepts (see buyWithETH). Use 0 for no protection.
    function buyWithToken(address asset, uint256 amount, uint256 minTokens) external nonReentrant {
        IAggregator feed;
        if (asset == usdc) feed = usdcUsdFeed;
        else if (asset == usdt) feed = usdtUsdFeed;
        else revert("asset not accepted");
        uint256 p = _feedPrice(feed, STABLE_MAX_AGE);
        if (p > 1e8) p = 1e8; // never credit more than $1 per stablecoin; credit less if it depegs
        uint256 usd18 = Math.mulDiv(amount * 1e12, p, 1e8);
        uint256 used = _buy(asset, amount, usd18, minTokens);
        IERC20(asset).safeTransferFrom(msg.sender, treasury, used);
    }

    function _buy(address asset, uint256 paid, uint256 usd18, uint256 minTokens) internal returns (uint256 usedPaid) {
        (uint256 tokens, uint256 usdUsed, uint256 r) = _fill(usd18);
        require(tokens >= minTokens, "slippage");
        _checkLimits(msg.sender, usdUsed, r);
        roundSold[r] += tokens;
        totalSold += tokens;
        purchased[msg.sender] += tokens;
        if (roundSold[r] == roundCap(r)) {
            // sold out: the next round starts right away
            round = r + 1;
            roundStart = block.timestamp;
            if (r + 1 == ROUNDS) endTime = block.timestamp;
        }
        usedPaid = usdUsed == usd18 ? paid : Math.mulDiv(paid, usdUsed, usd18, Math.Rounding.Ceil);
        emit Purchased(msg.sender, asset, usedPaid, usdUsed, tokens, r);
    }

    function _fill(uint256 usd18) internal returns (uint256 tokens, uint256 usdUsed, uint256 r) {
        require(block.timestamp >= startTime, "not started");
        require(usd18 >= MIN_PURCHASE_USD, "below minimum");
        uint256 s;
        (r, s) = _roundState();
        require(r < ROUNDS, "presale ended");
        round = r;
        roundStart = s;
        require(token.balanceOf(address(this)) >= TOTAL_FOR_SALE, "not funded");
        uint256 price = priceOf(r);
        uint256 remaining = roundCap(r) - roundSold[r];
        tokens = Math.mulDiv(usd18, 1e18, price);
        usdUsed = usd18;
        if (tokens > remaining) {
            // the buyer gets what is left in the round, the rest is returned
            tokens = remaining;
            usdUsed = Math.mulDiv(tokens, price, 1e18, Math.Rounding.Ceil);
        }
        require(tokens > 0, "round sold out");
    }

    function _checkLimits(address buyer, uint256 usdUsed, uint256 r) internal {
        uint256 total = spentUsd[buyer] + usdUsed;
        require(total <= MAX_PER_WALLET_USD, "wallet limit");
        spentUsd[buyer] = total;
        if (r < EARLY_ROUNDS) {
            uint256 inRound = spentInRound[buyer][r] + usdUsed;
            require(inRound <= MAX_PER_ROUND_EARLY_USD, "round limit");
            spentInRound[buyer][r] = inRound;
        }
    }

    function _feedPrice(IAggregator feed, uint256 maxAge) internal view returns (uint256) {
        (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
        require(answer > 0, "bad price");
        require(updatedAt != 0 && block.timestamp - updatedAt <= maxAge, "stale price");
        return uint256(answer);
    }

    // ---------------------------------------------------------------- rounds

    /// Price of one ODX in USD (18 decimals): $0.008 + index * $0.003875
    function priceOf(uint256 index) public pure returns (uint256) {
        require(index < ROUNDS, "bad round");
        return (8_000 + index * 3_875) * 1e12;
    }

    function roundCap(uint256 index) public pure returns (uint256) {
        return index == ROUNDS - 1 ? TOTAL_FOR_SALE - PER_ROUND * (ROUNDS - 1) : PER_ROUND;
    }

    /// Applies time-outs: a round that is not sold out ends 12 days after it started.
    function _roundState() internal view returns (uint256 r, uint256 s) {
        r = round;
        s = roundStart;
        while (r < ROUNDS && block.timestamp >= s + ROUND_DURATION) {
            s += ROUND_DURATION;
            r++;
        }
    }

    function _endTime() internal view returns (uint256) {
        if (endTime != 0) return endTime;
        (uint256 r, uint256 s) = _roundState();
        return r == ROUNDS ? s : 0;
    }

    /// 0 until the presale has ended. Used by the vesting contracts.
    function presaleEnd() external view returns (uint256) {
        return _endTime();
    }

    function saleState()
        external
        view
        returns (uint256 roundIndex, uint256 priceUsd18, uint256 remainingTokens, uint256 roundEndsAt, bool ended)
    {
        (uint256 r, uint256 s) = _roundState();
        if (r >= ROUNDS) return (ROUNDS, 0, 0, 0, true);
        return (r, priceOf(r), roundCap(r) - roundSold[r], s + ROUND_DURATION, false);
    }

    /// How much USD this wallet can still spend. It looks at the wallet limits only, not at what is left in the round.
    function remainingAllowanceUsd(address buyer) external view returns (uint256 left) {
        (uint256 r, ) = _roundState();
        if (r >= ROUNDS) return 0;
        left = MAX_PER_WALLET_USD - spentUsd[buyer];
        if (r < EARLY_ROUNDS) {
            uint256 l2 = MAX_PER_ROUND_EARLY_USD - spentInRound[buyer][r];
            if (l2 < left) left = l2;
        }
    }

    // ---------------------------------------------------------------- after the sale

    /// Anyone can call. Burns every token above what buyers bought: the unsold tokens and any tokens
    /// sent here by mistake. Claims always call this first, so nothing has been claimed yet at this point.
    function finalize() public {
        if (finalized) return;
        (uint256 r, uint256 s) = _roundState();
        require(r == ROUNDS, "presale not ended");
        round = r;
        roundStart = s;
        if (endTime == 0) endTime = s;
        finalized = true;
        uint256 bal = token.balanceOf(address(this));
        uint256 toBurn = bal > totalSold ? bal - totalSold : 0;
        if (toBurn > 0) IBurnable(address(token)).burn(toBurn);
        emit Finalized(endTime, toBurn);
    }

    /// 40% at the end of the presale, 70% after 30 days, 100% after 90 days.
    function unlockedPercent() public view returns (uint256) {
        uint256 e = _endTime();
        if (e == 0 || block.timestamp < e) return 0;
        uint256 t = block.timestamp - e;
        if (t >= 90 days) return 100;
        if (t >= 30 days) return 70;
        return 40;
    }

    function claimable(address buyer) public view returns (uint256) {
        return (purchased[buyer] * unlockedPercent()) / 100 - claimed[buyer];
    }

    function claim() external nonReentrant {
        finalize();
        uint256 amount = claimable(msg.sender);
        require(amount > 0, "nothing to claim");
        claimed[msg.sender] += amount;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }
}