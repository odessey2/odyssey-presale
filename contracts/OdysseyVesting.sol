// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPresaleEnd {
    function presaleEnd() external view returns (uint256);
}

/// Linear vesting that starts at (presale end + cliff). Used for team, treasury, advisors, strategic reserve.
/// The start is read from the presale contract, so nobody can move it.
contract OdysseyVesting {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    IPresaleEnd public immutable presale;
    address public immutable beneficiary;
    uint256 public immutable cliff;
    uint256 public immutable duration;
    uint256 public released;

    event Released(address indexed beneficiary, uint256 amount);

    constructor(address token_, address presale_, address beneficiary_, uint256 cliff_, uint256 duration_) {
        require(token_ != address(0) && presale_ != address(0) && beneficiary_ != address(0) && duration_ > 0, "bad args");
        token = IERC20(token_);
        presale = IPresaleEnd(presale_);
        beneficiary = beneficiary_;
        cliff = cliff_;
        duration = duration_;
    }

    function vestedAmount() public view returns (uint256) {
        uint256 end = presale.presaleEnd();
        if (end == 0) return 0;
        uint256 start = end + cliff;
        if (block.timestamp < start) return 0;
        uint256 total = token.balanceOf(address(this)) + released;
        if (block.timestamp >= start + duration) return total;
        return (total * (block.timestamp - start)) / duration;
    }

    function releasable() public view returns (uint256) {
        return vestedAmount() - released;
    }

    function release() external {
        uint256 amount = releasable();
        require(amount > 0, "nothing to release");
        released += amount;
        token.safeTransfer(beneficiary, amount);
        emit Released(beneficiary, amount);
    }
}
