// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev TEST ONLY. Simulates ETH forced into a contract despite a missing receive function.
contract ForceEther {
    constructor(address payable recipient) payable {
        selfdestruct(recipient);
    }
}
