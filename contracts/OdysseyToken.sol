// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title ODX token. Fixed mint at deployment, no owner, no fees, no pause, no blacklist.
contract OdysseyToken is ERC20, ERC20Burnable, ERC20Permit, ERC20Votes {
    uint256 public constant MAX_SUPPLY = 1_500_000_000 ether;

    constructor(address initialHolder) ERC20("Odyssey DEX", "ODX") ERC20Permit("Odyssey DEX") {
        require(initialHolder != address(0), "zero holder");
        _mint(initialHolder, MAX_SUPPLY);
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
