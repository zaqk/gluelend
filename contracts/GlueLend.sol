// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GluedToolsERC20Base} from "@glue-finance/expansions-pack/contracts/tools/GluedToolsERC20Base.sol";
import {IGlueERC20} from "@glue-finance/expansions-pack/contracts/interfaces/IGlueERC20.sol";
import {IGlueLendToken} from "./interfaces/IGlueLendToken.sol";

contract GlueLend is GluedToolsERC20Base {

    struct LoanPosition {
        uint256 tokensBurned;
        address[] collateralAddresses;
        bool active;
    }

    uint256 public originationFee; // in PRECISION units (1e16 = 1%)
    address public owner;
    bool public paused;

    mapping(address => bool) public registeredTokens;
    mapping(address => address) public tokenGlue;

    mapping(address => mapping(address => LoanPosition)) internal _loans;
    mapping(address => mapping(address => mapping(address => uint256))) internal _collateralOwed;

    error NotOwner();
    error Paused();
    error TokenNotRegistered();
    error NoActiveLoan();
    error CollateralMismatch();
    error ZeroAmount();
    error SlippageExceeded(uint256 index, uint256 received, uint256 minimum);
    error FeeTooHigh();

    event TokenRegistered(address indexed token, address indexed glue);
    event Borrowed(address indexed user, address indexed token, uint256 amount, uint256 fee);
    event Repaid(address indexed user, address indexed token, uint256 tokensMinted);
    event PartialRepaid(address indexed user, address indexed token, uint256 tokensMinted);
    event OriginationFeeUpdated(uint256 newFee);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor(uint256 _originationFee) {
        require(_originationFee <= 5e16, "Fee > 5%");
        originationFee = _originationFee;
        owner = msg.sender;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function registerToken(address token) external onlyOwner {
        address glue = _initializeGlue(token);
        registeredTokens[token] = true;
        tokenGlue[token] = glue;
        emit TokenRegistered(token, glue);
    }

    function setOriginationFee(uint256 fee) external onlyOwner {
        if (fee > 5e16) revert FeeTooHigh();
        originationFee = fee;
        emit OriginationFeeUpdated(fee);
    }

    function pause() external onlyOwner { paused = true; }
    function unpause() external onlyOwner { paused = false; }

    // ═══════════════════════════════════════════════════════════════════════
    // BORROW
    // ═══════════════════════════════════════════════════════════════════════

    function borrow(
        address token,
        uint256 amount,
        address[] calldata collaterals,
        uint256[] calldata minOutputs
    ) external payable whenNotPaused nnrtnt {
        if (!registeredTokens[token]) revert TokenNotRegistered();
        if (amount == 0) revert ZeroAmount();
        require(collaterals.length > 0, "No collaterals");
        require(collaterals.length == minOutputs.length, "Length mismatch");

        LoanPosition storage pos = _loans[msg.sender][token];

        // If existing loan, must use same collaterals
        if (pos.active) {
            require(pos.collateralAddresses.length == collaterals.length, "Length mismatch");
            for (uint256 i = 0; i < collaterals.length; i++) {
                if (pos.collateralAddresses[i] != collaterals[i]) revert CollateralMismatch();
            }
        }

        address glue = tokenGlue[token];

        // Pull tokens from user
        _transferFromAsset(token, msg.sender, address(this), amount);

        // Record balances before unglue
        uint256[] memory balsBefore = new uint256[](collaterals.length);
        for (uint256 i = 0; i < collaterals.length; i++) {
            balsBefore[i] = _balanceOfAsset(collaterals[i], address(this));
        }

        // Approve and unglue
        _approveAsset(token, glue, amount);
        IGlueERC20(glue).unglue(collaterals, amount, address(this));

        // Accumulate position
        if (!pos.active) {
            pos.active = true;
            pos.collateralAddresses = collaterals;
        }
        pos.tokensBurned += amount;

        // Distribute collateral, record debt, send fee to glue
        uint256 totalFee = _settleCollateral(msg.sender, token, glue, collaterals, balsBefore, minOutputs);

        emit Borrowed(msg.sender, token, amount, totalFee);
    }

    function _settleCollateral(
        address borrower,
        address token,
        address glue,
        address[] calldata collaterals,
        uint256[] memory balsBefore,
        uint256[] calldata minOutputs
    ) internal returns (uint256 totalFee) {
        uint256 feeRate = originationFee;
        uint256 len = collaterals.length;

        for (uint256 i = 0; i < len; i++) {
            uint256 received = _balanceOfAsset(collaterals[i], address(this)) - balsBefore[i];
            if (received == 0) continue;

            totalFee += _processOneCollateral(borrower, token, glue, collaterals[i], received, feeRate, minOutputs[i], i);
        }
    }

    function _processOneCollateral(
        address borrower,
        address token,
        address glue,
        address collateral,
        uint256 received,
        uint256 feeRate,
        uint256 minOutput,
        uint256 index
    ) internal returns (uint256 fee) {
        fee = _md512(received, feeRate, PRECISION);
        uint256 userAmount = received - fee;

        if (userAmount < minOutput) {
            revert SlippageExceeded(index, userAmount, minOutput);
        }

        if (fee > 0) {
            _transferAsset(collateral, glue, fee);
        }

        _transferAsset(collateral, borrower, userAmount);
        _collateralOwed[borrower][token][collateral] += received;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // REPAY
    // ═══════════════════════════════════════════════════════════════════════

    function repay(address token) external payable whenNotPaused nnrtnt {
        LoanPosition storage pos = _loans[msg.sender][token];
        if (!pos.active) revert NoActiveLoan();

        address glue = tokenGlue[token];
        uint256 tokensBurned = pos.tokensBurned;

        for (uint256 i = 0; i < pos.collateralAddresses.length; i++) {
            address c = pos.collateralAddresses[i];
            uint256 owed = _collateralOwed[msg.sender][token][c];
            if (owed == 0) continue;
            _transferFromAsset(c, msg.sender, glue, owed);
            _collateralOwed[msg.sender][token][c] = 0;
        }

        IGlueLendToken(token).mint(msg.sender, tokensBurned);

        pos.active = false;
        pos.tokensBurned = 0;
        delete pos.collateralAddresses;

        _refundExcessETH();

        emit Repaid(msg.sender, token, tokensBurned);
    }

    function partialRepay(address token, uint256 tokenAmount) external payable whenNotPaused nnrtnt {
        LoanPosition storage pos = _loans[msg.sender][token];
        if (!pos.active) revert NoActiveLoan();
        if (tokenAmount == 0) revert ZeroAmount();
        require(tokenAmount <= pos.tokensBurned, "Exceeds debt");

        address glue = tokenGlue[token];
        uint256 burned = pos.tokensBurned;

        for (uint256 i = 0; i < pos.collateralAddresses.length; i++) {
            address c = pos.collateralAddresses[i];
            uint256 totalOwed = _collateralOwed[msg.sender][token][c];
            if (totalOwed == 0) continue;

            uint256 partialOwed = _md512(totalOwed, tokenAmount, burned);
            if (partialOwed == 0) continue;

            _transferFromAsset(c, msg.sender, glue, partialOwed);
            _collateralOwed[msg.sender][token][c] = totalOwed - partialOwed;
        }

        IGlueLendToken(token).mint(msg.sender, tokenAmount);
        pos.tokensBurned = burned - tokenAmount;

        if (pos.tokensBurned == 0) {
            pos.active = false;
            delete pos.collateralAddresses;
        }

        _refundExcessETH();

        emit PartialRepaid(msg.sender, token, tokenAmount);
    }

    function _refundExcessETH() internal {
        if (msg.value > 0) {
            uint256 bal = address(this).balance;
            if (bal > 0) {
                _transferAsset(address(0), msg.sender, bal);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW
    // ═══════════════════════════════════════════════════════════════════════

    function getLoanPosition(address user, address token)
        external
        view
        returns (
            uint256 tokensBurned,
            address[] memory collateralAddresses,
            uint256[] memory collateralAmounts,
            bool active
        )
    {
        LoanPosition storage pos = _loans[user][token];
        tokensBurned = pos.tokensBurned;
        collateralAddresses = pos.collateralAddresses;
        active = pos.active;

        collateralAmounts = new uint256[](collateralAddresses.length);
        for (uint256 i = 0; i < collateralAddresses.length; i++) {
            collateralAmounts[i] = _collateralOwed[user][token][collateralAddresses[i]];
        }
    }

    function previewBorrow(
        address token,
        uint256 amount,
        address[] calldata collaterals
    ) external view returns (uint256[] memory userAmounts, uint256[] memory fees) {
        require(registeredTokens[token], "Not registered");

        uint256[] memory raw = _getCollateralbyAmount(token, amount, collaterals);
        userAmounts = new uint256[](collaterals.length);
        fees = new uint256[](collaterals.length);
        uint256 feeRate = originationFee;

        for (uint256 i = 0; i < collaterals.length; i++) {
            fees[i] = _md512(raw[i], feeRate, PRECISION);
            userAmounts[i] = raw[i] - fees[i];
        }
    }
}
