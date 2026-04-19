// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Uniswap v4
import {BaseHook} from "v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";

// Fhenix CoFHE
import {FHE, InEuint128, euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

// Token
import {IFHERC20} from "./interface/IFHERC20.sol";

/// @title PrivateSettlementHook
/// @notice v4 hook that mediates encrypted treasury -> burner -> treasury flow for
///         prediction-market positions. Burner wallets (one-shot per Polymarket
///         position) get funded with an encrypted amount of fhUSDC, trade on
///         Polymarket off-chain, and on resolution the hook pulls encrypted
///         payout back to the treasury. The underlying v4 pool gates access:
///         only the treasury may add/remove liquidity, and only registered
///         burners may swap.
contract PrivateSettlementHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using FHE for uint256;

    // --------------------- Errors ---------------------
    error NotTreasury();
    error PositionExists();
    error PositionUnknown();
    error AlreadyResolved();
    error NotResolved();
    error AlreadySettled();
    error NotAuthorized();

    // --------------------- Events ---------------------
    event PositionFunded(bytes32 indexed positionId, address indexed burner);
    event PositionResolved(bytes32 indexed positionId);
    event PositionSettled(bytes32 indexed positionId, address indexed burner);

    // --------------------- Config ---------------------
    address public immutable treasury;
    IFHERC20 public immutable fhToken;

    // --------------------- State ----------------------
    // Encrypted state is only readable by parties granted via FHE.allow*.
    mapping(bytes32 => euint128) public positionFunding;
    mapping(bytes32 => euint128) public positionPayout;
    mapping(bytes32 => address) public positionBurner;
    mapping(bytes32 => bool) public positionResolved;
    mapping(bytes32 => bool) public positionSettled;

    /// @notice Registered burner set. A burner may swap on any pool the hook
    ///         protects until its associated position settles.
    mapping(address => bool) public authorizedBurner;

    constructor(IPoolManager _poolManager, IFHERC20 _fhToken, address _treasury) BaseHook(_poolManager) {
        fhToken = _fhToken;
        treasury = _treasury;
    }

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotTreasury();
        _;
    }

    // --------------------- Hook permissions ---------------------
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // --------------------- Treasury entrypoints ---------------------

    /// @notice Treasury transfers an encrypted amount of fhUSDC to a fresh
    ///         burner wallet and registers the position.
    /// @dev    Must be called by treasury. Burner is single-use.
    function fundBurner(address burner, bytes32 positionId, InEuint128 calldata amount) external onlyTreasury {
        if (positionBurner[positionId] != address(0)) revert PositionExists();

        euint128 amt = FHE.asEuint128(amount);
        FHE.allowThis(amt);
        FHE.allow(amt, treasury);
        FHE.allow(amt, address(fhToken));

        // Move encrypted balance treasury -> burner via HybridFHERC20.
        // HybridFHERC20._transferImpl pins amountToSend to 0 if funds insufficient.
        fhToken.transferFromEncrypted(treasury, burner, amt);

        positionFunding[positionId] = amt;
        positionBurner[positionId] = burner;
        authorizedBurner[burner] = true;

        emit PositionFunded(positionId, burner);
    }

    /// @notice Treasury records the encrypted payout owed by the burner once
    ///         the Polymarket position resolves. Payout = final burner balance.
    function markResolved(bytes32 positionId, InEuint128 calldata payout) external onlyTreasury {
        if (positionBurner[positionId] == address(0)) revert PositionUnknown();
        if (positionResolved[positionId]) revert AlreadyResolved();

        euint128 p = FHE.asEuint128(payout);
        FHE.allowThis(p);
        FHE.allow(p, treasury);

        positionPayout[positionId] = p;
        positionResolved[positionId] = true;

        emit PositionResolved(positionId);
    }

    /// @notice Pull the encrypted payout from the burner back to the treasury.
    ///         Callable by burner or treasury once the position is resolved.
    function settle(bytes32 positionId) external {
        if (!positionResolved[positionId]) revert NotResolved();
        if (positionSettled[positionId]) revert AlreadySettled();

        address burner = positionBurner[positionId];
        if (msg.sender != burner && msg.sender != treasury) revert NotAuthorized();

        euint128 payout = positionPayout[positionId];
        FHE.allow(payout, address(fhToken));
        fhToken.transferFromEncrypted(burner, treasury, payout);

        positionSettled[positionId] = true;
        authorizedBurner[burner] = false;

        emit PositionSettled(positionId, burner);
    }

    // --------------------- Gated pool callbacks ---------------------

    /// @dev hookData MUST be abi.encode(address) of the swap initiator (burner
    ///      for normal swaps, treasury for settlement swaps). `sender` from v4
    ///      is the router, not the user — so the router relays user identity
    ///      via hookData.
    function _beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata hookData)
        internal
        view
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        address user = _decodeUser(hookData);
        if (user != treasury && !authorizedBurner[user]) revert NotAuthorized();
        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata hookData)
        internal
        view
        override
        returns (bytes4)
    {
        if (_decodeUser(hookData) != treasury) revert NotTreasury();
        return BaseHook.beforeAddLiquidity.selector;
    }

    function _beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata hookData)
        internal
        view
        override
        returns (bytes4)
    {
        if (_decodeUser(hookData) != treasury) revert NotTreasury();
        return BaseHook.beforeRemoveLiquidity.selector;
    }

    // --------------------- Internals ---------------------
    function _decodeUser(bytes calldata hookData) private pure returns (address user) {
        if (hookData.length < 32) return address(0);
        user = abi.decode(hookData, (address));
    }
}
