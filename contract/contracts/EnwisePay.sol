// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {euint256, ebool, eaddress, e, inco} from "@inco/lightning/src/Lib.sol";
import {DecryptionAttestation} from "@inco/lightning/src/lightning-parts/DecryptionAttester.types.sol";
import {asBool} from "@inco/lightning/src/shared/TypeUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

/// @title EnwisePay
/// @notice Inco FHE shielded recipient + Permit2 witness invoicing.
/// Pre-encrypted recipient ct lives in the invoice link; relayer submits payInvoice
/// after payer signs a Permit2 PermitWitnessTransferFrom bound to the invoice slug.
contract EnwisePay is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using e for *;

    struct Note {
        address asset;
        uint256 amount;
        eaddress recipient;
        bool spent;
    }

    ISignatureTransfer public immutable PERMIT2;
    address public immutable relayer;

    uint256 public nextNoteId;
    mapping(uint256 => Note) public notes;
    mapping(bytes32 => uint256) public slugToNoteId; // 0 == unpaid

    /// @dev EIP-712 typehash for the witness data bound into Permit2 signatures.
    bytes32 public constant INVOICE_TYPEHASH = keccak256(
        "InvoicePayment(bytes32 slug,bytes32 ctCommit,address settlement,uint256 expiry)"
    );

    /// @dev Witness type string for permitWitnessTransferFrom. Must follow EIP-712 ordering
    /// of nested structs and include the TokenPermissions definition (per Permit2 spec).
    string public constant INVOICE_WITNESS_STRING =
        "InvoicePayment witness)InvoicePayment(bytes32 slug,bytes32 ctCommit,address settlement,uint256 expiry)TokenPermissions(address token,uint256 amount)";

    event Shielded(uint256 indexed noteId, bytes32 indexed slug, address asset, uint256 amount);
    event Unshielded(uint256 indexed noteId, address indexed recipient);

    error NotRelayer();
    error InsufficientFee();
    error AlreadyPaid();
    error AlreadySpent();
    error InvalidAttestation();
    error HandleMismatch();
    error NotRecipient();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    constructor(address _permit2, address _relayer) {
        PERMIT2 = ISignatureTransfer(_permit2);
        relayer = _relayer;
    }

    /// @notice Pulls payer's tokens via Permit2 witness, then materializes the encrypted
    /// recipient handle on-chain. Only callable by the relayer because the ct is bound
    /// (via accountAddress) to the relayer's address.
    function payInvoice(
        bytes32 slug,
        bytes calldata recipientCt,
        address payer,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature
    ) external payable onlyRelayer nonReentrant returns (uint256 noteId) {
        if (msg.value < inco.getFee()) revert InsufficientFee();
        if (slugToNoteId[slug] != 0) revert AlreadyPaid();

        bytes32 witness = keccak256(
            abi.encode(
                INVOICE_TYPEHASH,
                slug,
                keccak256(recipientCt),
                address(this),
                permit.deadline
            )
        );

        PERMIT2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: permit.permitted.amount
            }),
            payer,
            witness,
            INVOICE_WITNESS_STRING,
            signature
        );

        // newEaddress reverts if msg.sender does not match the ciphertext's accountAddress.
        // It also forwards inco.getFee() out of msg.value to the Inco executor.
        eaddress recipient = recipientCt.newEaddress(msg.sender);
        // Canonical Inco pattern: grant access to BOTH the contract (so unShield's
        // e.eq recompute works in a future tx) and msg.sender (the relayer, so it
        // can run attestedCompute off-chain to produce the unShield attestation).
        recipient.allowThis();
        recipient.allow(msg.sender);

        unchecked { noteId = ++nextNoteId; }
        notes[noteId] = Note(permit.permitted.token, permit.permitted.amount, recipient, false);
        slugToNoteId[slug] = noteId;

        emit Shielded(noteId, slug, permit.permitted.token, permit.permitted.amount);
    }

    /// @notice Claim a note. Anyone may submit; funds always go to `recipient` and only
    /// succeed if the attestation cryptographically proves recipient == decrypted handle.
    function unShield(
        uint256 noteId,
        address recipient,
        DecryptionAttestation calldata att,
        bytes[] calldata sigs
    ) external nonReentrant {
        Note storage n = notes[noteId];
        if (n.spent) revert AlreadySpent();
        if (!inco.incoVerifier().isValidDecryptionAttestation(att, sigs)) revert InvalidAttestation();
        if (ebool.unwrap(e.eq(n.recipient, recipient)) != att.handle) revert HandleMismatch();
        if (!asBool(att.value)) revert NotRecipient();

        n.spent = true;
        IERC20(n.asset).safeTransfer(recipient, n.amount);
        emit Unshielded(noteId, recipient);
    }
}
