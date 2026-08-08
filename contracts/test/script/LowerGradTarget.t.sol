// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {BondingCurve} from "src/curve/BondingCurve.sol";
import {CurveFactory} from "src/curve/CurveFactory.sol";
import {DeployFreshLocal} from "script/DeployFreshLocal.s.sol";
import {LowerGradTarget} from "script/LowerGradTarget.s.sol";

contract LowerGradTargetTest is Test {
    function test_MainnetRequiresExplicitAckBeforeBroadcast() public {
        vm.chainId(1);
        CurveFactory cf = _deployCurveFactory();
        cf.setDefaults(cf.defaultCurveSupply(), cf.defaultVirtualTokenReserve(), 1_000_000 ether, 4 ether, 100);
        _writeDeploymentBook(cf);
        vm.setEnv("TARGET_ETH", "1000000000000000");
        LowerGradTarget script = new LowerGradTarget();

        vm.expectRevert(LowerGradTarget.LowerGradTarget__MainnetRequiresAck.selector);
        script.run();

        vm.removeFile("deployment.1.json");
    }

    function test_TargetMustStayBelowSafeCurveExhaustionPoint() public {
        vm.chainId(31_337);
        CurveFactory cf = _deployCurveFactory();
        _writeDeploymentBook(cf);
        vm.setEnv("TARGET_ETH", "4800000000000000000");
        LowerGradTarget script = new LowerGradTarget();

        vm.expectRevert(
            abi.encodeWithSelector(
                LowerGradTarget.LowerGradTarget__TargetExhaustsCurve.selector, uint256(4.8 ether), uint256(4.75 ether)
            )
        );
        script.run();

        vm.removeFile("deployment.31337.json");
    }

    function test_DeployFreshMainnetTinyFeesRequireExplicitAck() public {
        vm.chainId(1);
        address poolManager = makeAddr("poolManager");
        vm.etch(poolManager, hex"00");
        vm.setEnv("V4_POOL_MANAGER", vm.toString(poolManager));
        vm.setEnv("URU_TOKEN_ADDRESS", vm.toString(makeAddr("uru")));
        vm.setEnv("GEMU_NFT_ADDRESS", vm.toString(makeAddr("gemu")));
        vm.setEnv("MIN_URU_FEE", "1");
        vm.setEnv("ERC20_FEE_WEI", "1");

        DeployFreshLocal script = new DeployFreshLocal();
        vm.expectRevert(DeployFreshLocal.DeployFresh__MainnetTinyFeesRequireAck.selector);
        script.run();
    }

    function _deployCurveFactory() internal returns (CurveFactory) {
        return new CurveFactory(address(this), makeAddr("feeReceiver"), address(new BondingCurve()));
    }

    function _writeDeploymentBook(
        CurveFactory cf
    ) internal {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        string memory json = vm.serializeAddress(obj, "CurveFactory", address(cf));
        vm.writeJson(json, string.concat("deployment.", vm.toString(block.chainid), ".json"));
    }
}
