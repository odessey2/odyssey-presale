// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// TEST/TESTNET ONLY. Never deploy to mainnet.
contract MockStable is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockFeed {
    int256 public answer;
    uint256 public staleAt; // 0 = report "now"; otherwise report this fixed update time

    constructor(int256 a) {
        answer = a;
    }

    function set(int256 a) external {
        answer = a;
    }

    function setStale(uint256 t) external {
        staleAt = t;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 t = staleAt == 0 ? block.timestamp : staleAt;
        return (1, answer, t, t, 1);
    }
}