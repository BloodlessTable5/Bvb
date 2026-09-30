// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice TEST ONLY: native test ETH and a hardcoded, synthetic three-player score fixture.
/// @dev This is not a production fee contract or an authenticated scoreboard oracle.
contract HolderTestPayoutVault {
    uint256 public constant DISTRIBUTION_BPS = 2000;
    uint256 public constant MAX_FUNDING = 0.05 ether;
    uint256 public constant SCORE_TOTAL = 752;

    // Assigned once in the constructor; no transfer or mutation API exists.
    address public owner;
    uint256 public carry;
    uint256 public retainedBalance;
    uint256 private entered;

    struct Funding { uint256 amount; bool spent; }
    mapping(bytes32 => Funding) public fundings;
    mapping(bytes32 => bool) public batches;

    error TestChainOnly();
    error OwnerOnly();
    error ReentrantCall();
    error InvalidFunding();
    error FundingUnavailable();
    error InvalidBatch();
    error InvalidRecipients();
    error InvalidWithdrawal();
    error TransferFailed();
    error UseFundFunction();

    event Funded(bytes32 indexed fundingId, uint256 amount);
    event Paid(bytes32 indexed batchId, address indexed recipient, uint256 amount);
    event Distributed(bytes32 indexed batchId, bytes32 indexed fundingId, uint256 paid, uint256 carry);
    event Refunded(bytes32 indexed fundingId, uint256 amount);
    event RetainedWithdrawn(address indexed recipient, uint256 amount);

    modifier onlyTestChain() {
        if (block.chainid != 46630 && block.chainid != 31337) revert TestChainOnly();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OwnerOnly();
        _;
    }

    modifier nonReentrant() {
        if (entered != 0) revert ReentrantCall();
        entered = 1;
        _;
        entered = 0;
    }

    constructor() onlyTestChain { owner = msg.sender; }

    function fund(bytes32 fundingId) external payable onlyOwner onlyTestChain nonReentrant {
        if (fundingId == bytes32(0) || fundings[fundingId].amount != 0 || msg.value == 0 || msg.value > MAX_FUNDING) {
            revert InvalidFunding();
        }
        fundings[fundingId] = Funding(msg.value, false);
        emit Funded(fundingId, msg.value);
    }

    function quoteDistribution(bytes32 fundingId) public view returns (
        uint256 pool, uint256[3] memory amounts, uint256 paid, uint256 nextCarry
    ) {
        Funding memory funding = fundings[fundingId];
        if (funding.amount == 0 || funding.spent) revert FundingUnavailable();
        pool = funding.amount * DISTRIBUTION_BPS / 10000 + carry;
        amounts[0] = pool * 216 / SCORE_TOTAL;
        amounts[1] = pool * 50 / SCORE_TOTAL;
        amounts[2] = pool * 486 / SCORE_TOTAL;
        paid = amounts[0] + amounts[1] + amounts[2];
        nextCarry = pool - paid;
    }

    function distribute(bytes32 batchId, bytes32 fundingId, address[] calldata recipients)
        external onlyOwner onlyTestChain nonReentrant
    {
        if (batchId == bytes32(0) || batches[batchId]) revert InvalidBatch();
        if (recipients.length != 3) revert InvalidRecipients();
        for (uint256 i = 0; i < 3; i++) {
            if (recipients[i] == address(0) || recipients[i] == owner || recipients[i] == address(this)) revert InvalidRecipients();
            for (uint256 j = 0; j < i; j++) if (recipients[i] == recipients[j]) revert InvalidRecipients();
        }
        (, uint256[3] memory amounts, uint256 paid, uint256 nextCarry) = quoteDistribution(fundingId);
        Funding storage funding = fundings[fundingId];
        uint256 newPool = funding.amount * DISTRIBUTION_BPS / 10000;
        funding.spent = true;
        batches[batchId] = true;
        retainedBalance += funding.amount - newPool;
        carry = nextCarry;
        for (uint256 i = 0; i < 3; i++) {
            (bool success,) = payable(recipients[i]).call{value: amounts[i]}("");
            if (!success) revert TransferFailed();
            emit Paid(batchId, recipients[i], amounts[i]);
        }
        emit Distributed(batchId, fundingId, paid, nextCarry);
    }

    function refundUndistributed(bytes32 fundingId) external onlyOwner onlyTestChain nonReentrant {
        Funding storage funding = fundings[fundingId];
        if (funding.amount == 0 || funding.spent) revert FundingUnavailable();
        funding.spent = true;
        uint256 amount = funding.amount;
        (bool success,) = payable(owner).call{value: amount}("");
        if (!success) revert TransferFailed();
        emit Refunded(fundingId, amount);
    }

    function withdrawRetained(address payable recipient, uint256 amount) external onlyOwner onlyTestChain nonReentrant {
        if (recipient == address(0) || recipient == address(this) || amount == 0 || amount > retainedBalance) revert InvalidWithdrawal();
        retainedBalance -= amount;
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit RetainedWithdrawn(recipient, amount);
    }

    receive() external payable { revert UseFundFunction(); }
    fallback() external payable { revert UseFundFunction(); }
}
