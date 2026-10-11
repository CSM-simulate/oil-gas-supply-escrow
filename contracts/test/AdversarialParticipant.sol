// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev TEST ONLY. A participant that rejects ETH or tries to reenter on payment.
contract AdversarialParticipant {
    address public target;
    bytes public callback;
    bool public rejectEther;
    bool public callbackSucceeded;
    bytes4 public callbackError;
    uint256 public receipts;

    function configure(address target_, bytes calldata callback_, bool reject_) external {
        target = target_;
        callback = callback_;
        rejectEther = reject_;
    }

    function invoke(bytes calldata data) external payable returns (bytes memory) {
        (bool success, bytes memory result) = target.call{value: msg.value}(data);
        if (!success) {
            assembly { revert(add(result, 32), mload(result)) }
        }
        return result;
    }

    receive() external payable {
        require(!rejectEther, "Recipient rejects ETH");
        receipts++;
        if (callback.length != 0) {
            bytes memory data = callback;
            delete callback;
            bytes memory result;
            (callbackSucceeded, result) = target.call(data);
            if (result.length >= 4) {
                bytes4 selector;
                assembly { selector := mload(add(result, 32)) }
                callbackError = selector;
            }
        }
    }
}
