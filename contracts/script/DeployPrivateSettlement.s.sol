// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "v4-periphery/src/utils/HookMiner.sol";

import {PrivateSettlementHook} from "../src/PrivateSettlementHook.sol";
import {HybridFHERC20} from "../src/HybridFHERC20.sol";
import {IFHERC20} from "../src/interface/IFHERC20.sol";

/// @notice Deploys MERIDIAN's HybridFHERC20 (fhUSDC) and PrivateSettlementHook
///         to a Fhenix CoFHE-supported testnet. Primary target is Arbitrum
///         Sepolia (cheaper + faster than Eth Sepolia; both carry CoFHE).
///
/// Env vars:
///   POOL_MANAGER   — deployed v4 PoolManager address on the target chain
///   TREASURY       — MERIDIAN treasury EOA
///   PRIVATE_KEY    — deployer key
///
/// Usage:
///   forge script script/DeployPrivateSettlement.s.sol:DeployPrivateSettlement \
///     --rpc-url $ARB_SEPOLIA_RPC_URL --broadcast --via-ir
contract DeployPrivateSettlement is Script {
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external returns (HybridFHERC20 fhUSDC, PrivateSettlementHook hook) {
        IPoolManager poolManager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        address treasury = vm.envAddress("TREASURY");

        vm.startBroadcast();

        fhUSDC = new HybridFHERC20("MERIDIAN fhUSDC", "fhUSDC");

        uint160 permissions = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
        );
        bytes memory constructorArgs = abi.encode(poolManager, IFHERC20(address(fhUSDC)), treasury);
        (address predicted, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, permissions, type(PrivateSettlementHook).creationCode, constructorArgs);

        hook = new PrivateSettlementHook{salt: salt}(poolManager, IFHERC20(address(fhUSDC)), treasury);
        require(address(hook) == predicted, "DeployPrivateSettlement: hook address mismatch");

        vm.stopBroadcast();
    }
}
