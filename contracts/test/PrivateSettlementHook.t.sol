// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Foundry
import "forge-std/Test.sol";

// Uniswap v4
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {CurrencyLibrary, Currency} from "@uniswap/v4-core/src/types/Currency.sol";

// Fhenix CoFHE
import {FHE, InEuint128, euint128} from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import {CoFheTest} from "@fhenixprotocol/cofhe-foundry-mocks/CoFheTest.sol";

// MERIDIAN
import {PrivateSettlementHook} from "../src/PrivateSettlementHook.sol";
import {HybridFHERC20} from "../src/HybridFHERC20.sol";
import {IFHERC20} from "../src/interface/IFHERC20.sol";

// Test utils
import {Fixtures} from "./utils/Fixtures.sol";

contract PrivateSettlementHookTest is Test, Fixtures {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    CoFheTest CFT;

    PrivateSettlementHook hook;
    HybridFHERC20 fhUSDC;

    address treasury = makeAddr("treasury");
    address burner = makeAddr("burner");
    address outsider = makeAddr("outsider");

    bytes32 constant POSITION_A = bytes32(uint256(0xA));
    bytes32 constant POSITION_B = bytes32(uint256(0xB));

    uint128 constant SEED_AMOUNT = 10_000e6;
    uint128 constant FUND_AMOUNT = 1_000e6; // 1,000 USDC (6dp)
    uint128 constant PAYOUT_AMOUNT = 1_750e6; // winnings

    function setUp() public {
        CFT = new CoFheTest(false);

        // Deploy HybridFHERC20 at a fixed address for determinism
        bytes memory tokenArgs = abi.encode("Fhenix USDC", "fhUSDC");
        deployCodeTo("HybridFHERC20.sol:HybridFHERC20", tokenArgs, address(0xF100));
        fhUSDC = HybridFHERC20(address(0xF100));

        // Pool manager + routers (needed even though we don't swap — hook checks PoolManager identity)
        deployFreshManagerAndRouters();

        // Mine a hook address with the right flag bits
        address flags = address(
            uint160(
                Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            ) ^ (0x5555 << 144) // MERIDIAN namespace
        );
        bytes memory constructorArgs = abi.encode(manager, IFHERC20(address(fhUSDC)), treasury);
        deployCodeTo("PrivateSettlementHook.sol:PrivateSettlementHook", constructorArgs, flags);
        hook = PrivateSettlementHook(flags);

        vm.label(address(hook), "PrivateSettlementHook");
        vm.label(address(fhUSDC), "fhUSDC");
        vm.label(treasury, "treasury");
        vm.label(burner, "burner");

        // Seed treasury with encrypted fhUSDC balance
        vm.startPrank(treasury);
        InEuint128 memory seed = CFT.createInEuint128(SEED_AMOUNT, treasury);
        fhUSDC.mintEncrypted(treasury, seed);
        vm.stopPrank();
    }

    // ------------------------ Happy path ------------------------

    function test_fundBurner_moves_encrypted_balance() public {
        InEuint128 memory amount = CFT.createInEuint128(FUND_AMOUNT, treasury);

        vm.prank(treasury);
        hook.fundBurner(burner, POSITION_A, amount);

        // Treasury debited, burner credited
        CFT.assertHashValue(fhUSDC.encBalances(treasury), SEED_AMOUNT - FUND_AMOUNT);
        CFT.assertHashValue(fhUSDC.encBalances(burner), FUND_AMOUNT);

        assertEq(hook.positionBurner(POSITION_A), burner);
        assertTrue(hook.authorizedBurner(burner));
        assertFalse(hook.positionResolved(POSITION_A));
        assertFalse(hook.positionSettled(POSITION_A));
    }

    function test_settle_returns_payout_to_treasury() public {
        // Fund
        InEuint128 memory fund = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.fundBurner(burner, POSITION_A, fund);

        // Simulate burner winning: mint extra encrypted balance to burner so they
        // hold > FUND_AMOUNT (payout). In production the CLOB router would do this.
        uint128 winAmount = PAYOUT_AMOUNT - FUND_AMOUNT;
        InEuint128 memory win = CFT.createInEuint128(winAmount, burner);
        vm.prank(burner);
        fhUSDC.mintEncrypted(burner, win);
        CFT.assertHashValue(fhUSDC.encBalances(burner), PAYOUT_AMOUNT);

        // Treasury resolves with encrypted payout amount
        InEuint128 memory payout = CFT.createInEuint128(PAYOUT_AMOUNT, treasury);
        vm.prank(treasury);
        hook.markResolved(POSITION_A, payout);
        assertTrue(hook.positionResolved(POSITION_A));

        // Settle: payout flows burner -> treasury
        uint128 treasuryBefore = SEED_AMOUNT - FUND_AMOUNT;
        vm.prank(burner);
        hook.settle(POSITION_A);

        CFT.assertHashValue(fhUSDC.encBalances(treasury), treasuryBefore + PAYOUT_AMOUNT);
        CFT.assertHashValue(fhUSDC.encBalances(burner), 0);
        assertTrue(hook.positionSettled(POSITION_A));
        assertFalse(hook.authorizedBurner(burner));
    }

    function test_settle_callable_by_treasury() public {
        InEuint128 memory fund = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.fundBurner(burner, POSITION_A, fund);

        InEuint128 memory payout = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.markResolved(POSITION_A, payout);

        vm.prank(treasury);
        hook.settle(POSITION_A);

        assertTrue(hook.positionSettled(POSITION_A));
    }

    // ------------------------ Access control ------------------------

    function test_fundBurner_reverts_not_treasury() public {
        InEuint128 memory amount = CFT.createInEuint128(FUND_AMOUNT, outsider);
        vm.prank(outsider);
        vm.expectRevert(PrivateSettlementHook.NotTreasury.selector);
        hook.fundBurner(burner, POSITION_A, amount);
    }

    function test_markResolved_reverts_not_treasury() public {
        InEuint128 memory fund = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.fundBurner(burner, POSITION_A, fund);

        InEuint128 memory payout = CFT.createInEuint128(FUND_AMOUNT, outsider);
        vm.prank(outsider);
        vm.expectRevert(PrivateSettlementHook.NotTreasury.selector);
        hook.markResolved(POSITION_A, payout);
    }

    function test_settle_reverts_unauthorized() public {
        InEuint128 memory fund = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.fundBurner(burner, POSITION_A, fund);

        InEuint128 memory payout = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.markResolved(POSITION_A, payout);

        vm.prank(outsider);
        vm.expectRevert(PrivateSettlementHook.NotAuthorized.selector);
        hook.settle(POSITION_A);
    }

    // ------------------------ State invariants ------------------------

    function test_fundBurner_reverts_position_exists() public {
        InEuint128 memory a = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.fundBurner(burner, POSITION_A, a);

        InEuint128 memory b = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        vm.expectRevert(PrivateSettlementHook.PositionExists.selector);
        hook.fundBurner(burner, POSITION_A, b);
    }

    function test_markResolved_reverts_unknown_position() public {
        InEuint128 memory payout = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        vm.expectRevert(PrivateSettlementHook.PositionUnknown.selector);
        hook.markResolved(POSITION_B, payout);
    }

    function test_markResolved_reverts_already_resolved() public {
        InEuint128 memory fund = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.fundBurner(burner, POSITION_A, fund);

        InEuint128 memory p1 = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.markResolved(POSITION_A, p1);

        InEuint128 memory p2 = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        vm.expectRevert(PrivateSettlementHook.AlreadyResolved.selector);
        hook.markResolved(POSITION_A, p2);
    }

    function test_settle_reverts_not_resolved() public {
        InEuint128 memory fund = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.fundBurner(burner, POSITION_A, fund);

        vm.prank(burner);
        vm.expectRevert(PrivateSettlementHook.NotResolved.selector);
        hook.settle(POSITION_A);
    }

    function test_settle_reverts_double_settle() public {
        InEuint128 memory fund = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.fundBurner(burner, POSITION_A, fund);

        InEuint128 memory payout = CFT.createInEuint128(FUND_AMOUNT, treasury);
        vm.prank(treasury);
        hook.markResolved(POSITION_A, payout);

        vm.prank(burner);
        hook.settle(POSITION_A);

        vm.prank(burner);
        vm.expectRevert(PrivateSettlementHook.AlreadySettled.selector);
        hook.settle(POSITION_A);
    }
}
