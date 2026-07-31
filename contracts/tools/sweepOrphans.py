#!/usr/bin/env python3
"""Sweep every historical RH CurveFactory for orphaned curves — curves
holding non-zero ETH that never graduated. Emit a machine-readable JSON
of {curveAddress, tokenAddress, ethBalance, tokenName, tokenSymbol,
graduated, launcher, factoryAddress} for the recover page + humans."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

ENV_PATH = Path("C:/Users/brand/OneDrive/Desktop/launchpad/.env")
RPC = ""
for line in ENV_PATH.read_text().splitlines():
    if line.startswith("ROBINHOOD_RPC_URL="):
        RPC = line.split("=", 1)[1].strip()
        break
assert RPC, "no RPC URL"

# Every RH CurveFactory we've deployed (verified live above)
CFS = [
    "0x8661bb85ee8140659e172774dece6de27166acc2",  # V2
    "0x14b2ffb9e183ba51faaf880f89490484f25b9223",  # Phase1
    "0xdcf743af55b0a15238af6bdcac6597ce5eec9e2b",  # V3
    "0x4631c21b066d3b289779e477fc79f13e8d0fc248",  # V4 (also V5)
    "0x1c340f092c89d018d7f6410b0a418253fb522c70",  # V6/V7/V8 CURRENT
    "0xff0b02818b0d39bd43019b2ceb2d952c29dd851c",  # FixV2
    "0x771957b899bf8d2363d4fe7c103cb0bb980d4da1",  # MigrateToV2Templates
    "0xFfda6614A6d527eb1e0b19C6B9DbdD1e243A1904",  # mystery — where URUFU lives
]

CURVE_CREATED_TOPIC = "0x5beb1a9316febdf79449530de709e3300ab301e2a47cf3ce7928a27e11ca9c1d"

def cast(*args, timeout=60):
    r = subprocess.run(
        ["cast", *args, "--rpc-url", RPC],
        capture_output=True, text=True, timeout=timeout
    )
    if r.returncode != 0:
        return None
    return r.stdout.strip()

# Get current block
current_block = int(cast("block-number"), 10) if cast("block-number") else 0
print(f"current block: {current_block}", file=sys.stderr)

# Regex: 32-byte padded topic line
padded_re = re.compile(r"^\s*(0x[0-9a-fA-F]{64})\s*$", re.M)

all_curves = []  # list of dicts

for cf in CFS:
    print(f"\n=== CF {cf} ===", file=sys.stderr)
    logs = cast("logs", "--address", cf, "--from-block", "18000000", "--to-block",
                str(current_block), "CurveCreated(address,address,address)")
    if not logs:
        print(f"  no logs", file=sys.stderr)
        continue

    # Each log has: 4 topics (sig, token, curve, launcher), we need topics 1-3.
    # cast logs prints one 'topics: [ ... ]' block per event with lines like
    #   0x5beb1a... (sig)
    #   0x000...token
    #   0x000...curve
    #   0x000...launcher
    # Parse block-by-block by splitting on `- ` (the start-of-event marker).
    events = logs.split("- address")
    for ev in events[1:]:
        m = padded_re.findall(ev)
        # m = [sig, token, curve, launcher]  after the topics block
        if len(m) < 4:
            continue
        token = "0x" + m[1][-40:]
        curve = "0x" + m[2][-40:]
        launcher = "0x" + m[3][-40:]
        all_curves.append({"factory": cf, "token": token, "curve": curve, "launcher": launcher})

print(f"\nfound {len(all_curves)} total curves across all CFs", file=sys.stderr)

# For each curve: balance, graduated?, then if orphan (bal>0 && !graduated) fetch token name/symbol.
orphans = []
for i, c in enumerate(all_curves):
    curve = c["curve"]
    bal_hex = cast("balance", curve)
    bal = int(bal_hex) if bal_hex else 0
    if bal == 0:
        continue
    graduated_out = cast("call", curve, "graduated()(bool)")
    graduated = (graduated_out or "").strip().lower() == "true"
    if graduated:
        continue
    # It's an orphan.
    name = cast("call", c["token"], "name()(string)") or ""
    symbol = cast("call", c["token"], "symbol()(string)") or ""
    gradTarget = cast("call", curve, "graduationTargetEth()(uint256)")
    orphans.append({
        **c,
        "balanceWei": str(bal),
        "balanceEth": bal / 1e18,
        "tokenName": name.strip('"'),
        "tokenSymbol": symbol.strip('"'),
        "graduationTargetWei": gradTarget or "0",
        "graduated": False,
    })
    print(f"  ORPHAN: {name.strip(chr(34))} ({symbol.strip(chr(34))})  bal={bal/1e18:.4f} ETH  curve={curve}  cf={c['factory']}", file=sys.stderr)

out = {
    "sweptAt": current_block,
    "cfsScanned": CFS,
    "totalCurvesFound": len(all_curves),
    "orphans": orphans,
}
print(json.dumps(out, indent=2))
