// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Oil and gas batch escrow
/// @notice One fixed buyer and supplier; the buyer explicitly accepts or rejects delivery.
/// @dev Native ETH only. Physical delivery and specification compliance are assessed off-chain.
contract OilGasEscrow is ReentrancyGuard, AccessControl {
    bytes32 public constant BUYER_ROLE = keccak256("BUYER_ROLE");
    bytes32 public constant SUPPLIER_ROLE = keccak256("SUPPLIER_ROLE");

    enum Status { Created, Funded, Delivered, Released, Refunded }

    struct Batch {
        uint256 id;
        uint256 volume;
        uint256 priceWei;
        bytes32 specHash;
        Status status;
        uint256 deadline;
    }

    address public immutable buyer;
    address public immutable supplier;
    /// @notice Sum of prices of all Funded and Delivered batches.
    uint256 public totalEscrowed;
    mapping(uint256 => Batch) private _batches;
    mapping(uint256 => bool) private _exists;

    error InvalidParticipants();
    error InvalidBatchParameters();
    error BatchAlreadyExists(uint256 id);
    error BatchNotFound(uint256 id);
    error InvalidStatus(uint256 id, Status actual, Status expected);
    error IncorrectPayment(uint256 actual, uint256 expected);
    error DeadlinePassed(uint256 id);
    error DeadlineNotReached(uint256 id);
    error TransferFailed(address recipient, uint256 amount);
    error RolesImmutable();

    event BatchCreated(uint256 indexed id, uint256 volume, uint256 priceWei, bytes32 specHash, uint256 deadline);
    event Funded(uint256 indexed id, address indexed payer, uint256 amount);
    event Delivered(uint256 indexed id, address indexed supplier);
    event PaymentReleased(uint256 indexed id, address indexed supplier, uint256 amount);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 amount);
    event BatchRejected(uint256 indexed id, bytes32 reasonHash);

    modifier onlyBuyer() {
        _checkRole(BUYER_ROLE);
        _;
    }

    modifier onlySupplier() {
        _checkRole(SUPPLIER_ROLE);
        _;
    }

    /// @param buyer_ Address that creates, funds and accepts batches.
    /// @param supplier_ Address that declares delivery and receives accepted payments.
    /// @dev No DEFAULT_ADMIN_ROLE is granted; participants cannot be replaced.
    constructor(address buyer_, address supplier_) {
        if (buyer_ == address(0) || supplier_ == address(0) || buyer_ == supplier_) {
            revert InvalidParticipants();
        }
        buyer = buyer_;
        supplier = supplier_;
        _grantRole(BUYER_ROLE, buyer_);
        _grantRole(SUPPLIER_ROLE, supplier_);
    }

    /// @notice Creates a unique order with immutable metadata; id zero is valid.
    /// @param id Unique batch identifier, never reused.
    /// @param volume Positive integer quantity in the unit specified in the hashed document.
    /// @param priceWei Full price in wei.
    /// @param specHash Keccak256 hash of the agreed specification and accompanying metadata.
    /// @param deadline Last exclusive delivery timestamp in Unix seconds.
    function createBatch(uint256 id, uint256 volume, uint256 priceWei, bytes32 specHash, uint256 deadline)
        external onlyBuyer
    {
        if (_exists[id]) revert BatchAlreadyExists(id);
        if (volume == 0 || priceWei == 0 || specHash == bytes32(0) || deadline <= block.timestamp) {
            revert InvalidBatchParameters();
        }
        _exists[id] = true;
        _batches[id] = Batch(id, volume, priceWei, specHash, Status.Created, deadline);
        emit BatchCreated(id, volume, priceWei, specHash, deadline);
    }

    /// @notice Deposits exactly the batch price before the deadline.
    function fundBatch(uint256 id) external payable onlyBuyer nonReentrant {
        Batch storage batch = _getBatch(id);
        _expectStatus(batch, Status.Created);
        if (block.timestamp >= batch.deadline) revert DeadlinePassed(id);
        if (msg.value != batch.priceWei) revert IncorrectPayment(msg.value, batch.priceWei);
        batch.status = Status.Funded;
        totalEscrowed += batch.priceWei;
        emit Funded(id, msg.sender, msg.value);
    }

    /// @notice Declares delivery; does not authorize a payment.
    function markDelivered(uint256 id) external onlySupplier {
        Batch storage batch = _getBatch(id);
        _expectStatus(batch, Status.Funded);
        if (block.timestamp >= batch.deadline) revert DeadlinePassed(id);
        batch.status = Status.Delivered;
        emit Delivered(id, supplier);
    }

    /// @notice Buyer confirms receipt and specification compliance, paying the supplier.
    /// @dev CEI and nonReentrant; a rejected ETH transfer rolls all state changes back.
    function releasePayment(uint256 id) external onlyBuyer nonReentrant {
        Batch storage batch = _getBatch(id);
        _expectStatus(batch, Status.Delivered);
        batch.status = Status.Released;
        totalEscrowed -= batch.priceWei;
        emit PaymentReleased(id, supplier, batch.priceWei);
        _send(supplier, batch.priceWei);
    }

    /// @notice Returns an undelivered funded batch to the buyer at or after its deadline.
    function refund(uint256 id) external onlyBuyer nonReentrant {
        Batch storage batch = _getBatch(id);
        _expectStatus(batch, Status.Funded);
        if (block.timestamp < batch.deadline) revert DeadlineNotReached(id);
        batch.status = Status.Refunded;
        totalEscrowed -= batch.priceWei;
        emit Refunded(id, buyer, batch.priceWei);
        _send(buyer, batch.priceWei);
    }

    /// @notice Rejects a delivered batch and immediately returns its payment to the buyer.
    /// @param reasonHash Nonzero hash of an off-chain rejection report.
    /// @dev Adds the rejection path described in the scenario while preserving the five statuses.
    function rejectBatch(uint256 id, bytes32 reasonHash) external onlyBuyer nonReentrant {
        Batch storage batch = _getBatch(id);
        _expectStatus(batch, Status.Delivered);
        if (reasonHash == bytes32(0)) revert InvalidBatchParameters();
        batch.status = Status.Refunded;
        totalEscrowed -= batch.priceWei;
        emit BatchRejected(id, reasonHash);
        emit Refunded(id, buyer, batch.priceWei);
        _send(buyer, batch.priceWei);
    }

    /// @notice Gets all metadata; unknown ids revert instead of returning misleading defaults.
    function getBatch(uint256 id) external view returns (Batch memory) {
        return _getBatch(id);
    }

    /// @notice Whether the identifier has ever been allocated.
    function batchExists(uint256 id) external view returns (bool) {
        return _exists[id];
    }

    /// @notice Fixed roles cannot be renounced, which could otherwise permanently lock funds.
    function renounceRole(bytes32, address) public pure override {
        revert RolesImmutable();
    }

    function _getBatch(uint256 id) private view returns (Batch storage batch) {
        if (!_exists[id]) revert BatchNotFound(id);
        return _batches[id];
    }

    function _expectStatus(Batch storage batch, Status expected) private view {
        if (batch.status != expected) revert InvalidStatus(batch.id, batch.status, expected);
    }

    function _send(address recipient, uint256 amount) private {
        (bool success, ) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed(recipient, amount);
    }
}
