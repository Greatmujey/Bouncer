#!/usr/bin/env python3
"""Narrow offline static comparison for ONE recovered V11 artifact.

Inputs are local and digest-pinned. WABT validates the module with selected
features disabled; its reported host-import signatures are compared with
one of two pinned nearcore source profiles' import declarations and selected
protocol diffs. No RPC, seller, signatures, compilation or transactions. This is NOT a
nearcore execution, consensus/fee check, complete validator, code audit, or
proof that the artifact was built from this repository's Rust source.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile

EXPECTED_WASM_SHA256 = '1acf931c07a530257999478c121193863ecf7201d357812a44b4d61c16a77921'
EXPECTED_WASM_SIZE = 536_325
NEARCORE_COMMIT = 'bc4e9e8cfb03d9e82f027883055624e18576993e'  # 2.14.0
SOURCE_SHA256 = {
    'runtime/near-vm-runner/src/imports.rs': '19124f190457cf856f22a1b015d19d882836bfee2b9484f6bdb90aed85444520',
    'core/parameters/res/runtime_configs/parameters.yaml': '3a73e1f62746e965c398533ccfaa5579ac5921ca70f7013b3b8a695d275536df',
    'core/parameters/res/runtime_configs/parameters_testnet.yaml': 'a78f78325b4fbb1b0e5f5f4b30a45976f8098b14fa525a13118ee609c2cad535',
    'core/parameters/res/runtime_configs/78.yaml': '461e81e1aacdaddc4a0ade0adf69ad6ace793c3a694d8c35c2c7524a6c88d57b',
    'core/parameters/res/runtime_configs/84.yaml': '8f860426b89f9d681b40187ede410563ef3d1503a8f360261b83a064a26f7792',
    'core/parameters/res/runtime_configs/85.yaml': 'fa4169a67850342c71a517239e5882eb4987c1b32d4b1055c3cb6798bac10c2b',
    'core/parameters/res/runtime_configs/88.yaml': '38ac9c614478e36ad4db676f995d1ca68502123f29e1f29ccebd3863406c24b0',
}
# The public testnet status endpoint reported this older rc.5 commit on
# 2026-11-02. Its selected 87/88 diffs differ from the final 2.14.0 release:
# it enables universal accounts at 87, not 88. A status response does not
# attest the node binary, all validators or the network's runtime config.
TESTNET_RC5_COMMIT = 'b7b4737cab46f17a6daa2ed694d7aebbd204363a'
TESTNET_RC5_SOURCE_SHA256 = {
    **SOURCE_SHA256,
    'core/parameters/res/runtime_configs/87.yaml': 'bffdc7c3a54df7b12ca344f75d28e3844e60f6e252ed7c304f650e0727c1a36c',
    'core/parameters/res/runtime_configs/88.yaml': '0c6d8a1d013a553c98260aaf51d2a8aff1f54dd925a7e3b10f5d064256c796f7',
    'core/parameters/src/view.rs': '232d7a2b69b2df7b94505073395524968d7b262afc9c73d577197b7d8959ab8d',
    'core/primitives-core/src/version.rs': 'e3cdb3e17d1b9d76ec824c1d77f4cb7e492d3be0385132a3cbeffb5a6cead4a2',
}
SOURCE_PROFILES = {
    'release-2.14.0': (NEARCORE_COMMIT, SOURCE_SHA256, 88),
    'testnet-rc5-20261102': (TESTNET_RC5_COMMIT, TESTNET_RC5_SOURCE_SHA256, 87),
}
EXPECTED_GATE_COUNTS = {'ungated_declaration': 33, 'global_contract_host_fns': 4,
                        'gas_key_host_fns': 3, 'universal_accounts': 1}
WABT_VERSION = '1.0.39'
ROOT = pathlib.Path(__file__).resolve().parents[1]


def read_pinned(path: pathlib.Path, digest: str, maximum: int) -> bytes:
    """Read bounded regular input without following a final-component symlink."""
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size < 1 or info.st_size > maximum:
            raise ValueError('invalid size or type')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(info.st_size + 1)
        if len(data) != info.st_size or os.fstat(fd).st_size != info.st_size or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('size or digest mismatch')
        return data
    except (OSError, ValueError) as exc:
        raise ValueError('pinned input missing, unsafe or changed') from exc
    finally:
        if fd is not None:
            os.close(fd)


def _wasm_type(typ: str) -> str:
    return {'u64': 'i64', 'i64': 'i64', 'u32': 'i32', 'i32': 'i32', 'f32': 'f32', 'f64': 'f64'}.get(typ, typ)


def parse_nearcore_declarations(source: str) -> dict[str, tuple[str, tuple[tuple[str, ...], tuple[str, ...]]]]:
    pattern = re.compile(r'(?:#\[([A-Za-z_][A-Za-z_0-9]*)\]\s*)?(\w+)<\[\s*(.*?)\s*\]\s*->\s*\[\s*(.*?)\s*\]>', re.S)
    result = {}
    for gate, name, raw_args, raw_result in pattern.findall(source):
        if name in result:
            raise ValueError('ambiguous nearcore host declaration')
        args = tuple(_wasm_type(x) for x in re.findall(r':\s*(\w+)', raw_args))
        returns = tuple(_wasm_type(x) for x in re.findall(r'\b(?:u64|i64|u32|i32|f32|f64)\b', raw_result))
        result[name] = (gate or 'ungated_declaration', (args, returns))
    if not result:
        raise ValueError('nearcore host declarations unavailable')
    return result


def parse_wabt_details(text: str) -> dict[str, tuple[tuple[str, ...], tuple[str, ...]]]:
    types = {}
    for index, args, returns in re.findall(r'^ - type\[(\d+)\] \(([^)]*)\) -> (.+)$', text, re.M):
        number = int(index)
        if number in types:
            raise ValueError('duplicate WABT type')
        a = tuple(x.strip() for x in args.split(',') if x.strip())
        r = () if returns == 'nil' else tuple(x.strip() for x in returns.split(','))
        types[number] = (a, r)
    match = re.search(r'^Import\[(\d+)\]:\n(.*?)(?=^[A-Za-z][A-Za-z0-9]*\[|\Z)', text, re.M | re.S)
    if not types or not match:
        raise ValueError('WABT type or import section unavailable')
    count = int(match.group(1))
    import_lines = [line for line in match.group(2).splitlines() if line.startswith(' - ')]
    pattern = re.compile(r'^ - func\[\d+\] sig=(\d+) <env\.([^>]+)> <- env\.([^\s]+)$')
    rows = [pattern.fullmatch(line) for line in import_lines]
    if len(rows) != count or any(row is None for row in rows):
        raise ValueError('unexpected or non-function/non-env WASM import')
    imports = {}
    for row in rows:
        index, display_name, name = row.groups()
        if name != display_name or name in imports or int(index) not in types:
            raise ValueError('ambiguous WABT import')
        imports[name] = types[int(index)]
    return imports


def compare_host_abi(imports, declarations):
    gates = collections.Counter()
    for name, actual in imports.items():
        if name not in declarations:
            raise ValueError('WASM host import is not in the pinned nearcore declarations')
        gate, expected = declarations[name]
        if actual != expected:
            raise ValueError('WASM host signature differs from the pinned nearcore declaration')
        gates[gate] += 1
    return dict(sorted(gates.items()))


def check_selected_config(files: dict[str, str], universal_accounts_version: int = 88) -> dict[str, int]:
    if universal_accounts_version not in (87, 88):
        raise ValueError('unrecognized pinned universal-accounts feature version')
    prefixes = 'core/parameters/res/runtime_configs/'
    flags = {'global_contract_host_fns': 78, 'reftypes_bulk_memory': 84,
             'gas_key_host_fns': 85, 'universal_accounts': universal_accounts_version}
    for base in ('parameters.yaml', 'parameters_testnet.yaml'):
        text = files[prefixes + base]
        for name in flags:
            if not re.search(rf'^{name}:\s*false\s*$', text, re.M):
                raise ValueError('pinned nearcore base config does not match expected feature flags')
    for name, version in flags.items():
        text = files[f'{prefixes}{version}.yaml']
        if not re.search(rf'^{name}:\s*\{{\s*old:\s*false,\s*new:\s*true\s*\}}', text, re.M):
            raise ValueError('pinned nearcore protocol diff does not match expected feature flags')
    # For the rc.5 profile, inspect its next selected diff too; otherwise a
    # later explicit reversal at 88 would invalidate the 87-only indication.
    if universal_accounts_version == 87 and re.search(r'^universal_accounts\s*:', files[prefixes + '88.yaml'], re.M):
        raise ValueError('selected nearcore 88 diff changes universal-accounts again')
    return flags


def check_universal_feature_version(source: str, expected: int) -> None:
    found = re.findall(r'ProtocolFeature::UniversalAccounts\s*=>\s*(\d+)\s*,', source)
    if found != [str(expected)]:
        raise ValueError('pinned nearcore universal-accounts feature version differs')


def check_selected_protocol_view_fields(source: str) -> list[str]:
    """Check pinned source declarations and assignments, not live RPC behavior."""
    names = ('global_contract_host_fns', 'reftypes_bulk_memory', 'gas_key_host_fns', 'universal_accounts')
    patterns = [r'^\s*pub\s+wasm_config:\s*VMConfigView\s*,\s*$']
    patterns += [rf'^\s*pub\s+{name}:\s*bool\s*,\s*$' for name in names]
    patterns += [rf'^\s*{name}:\s*config\.{name}\s*,\s*$' for name in names]
    if any(len(re.findall(pattern, source, re.M)) != 1 for pattern in patterns):
        raise ValueError('selected protocol view fields missing or changed')
    return list(names)


def run_wabt(name: str, args: list[str], *, expected: int = 0) -> subprocess.CompletedProcess:
    executable = ROOT / 'node_modules' / '.bin' / name
    try:
        result = subprocess.run([str(executable), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding='utf-8', errors='strict', timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired, UnicodeError) as exc:
        raise ValueError('pinned WABT is unavailable or timed out; run npm ci --prefix bouncer') from exc
    if len(result.stdout) > 2_000_000 or len(result.stderr) > 200_000 or result.returncode != expected:
        raise ValueError('WABT could not validate or inspect the exact artifact as expected')
    return result


def inspect(wasm_path: pathlib.Path, source_dir: pathlib.Path, profile: str = 'release-2.14.0') -> dict:
    if profile not in SOURCE_PROFILES:
        raise ValueError('unrecognized pinned nearcore source profile')
    source_commit, source_hashes, universal_version = SOURCE_PROFILES[profile]
    data = read_pinned(wasm_path, EXPECTED_WASM_SHA256, EXPECTED_WASM_SIZE)
    if len(data) != EXPECTED_WASM_SIZE:
        raise ValueError('unexpected exact WASM size')
    texts = {name: read_pinned(source_dir / name, digest, 2_000_000).decode('utf-8', errors='strict')
             for name, digest in source_hashes.items()}
    versions = check_selected_config(texts, universal_version)
    view_fields = None
    if profile == 'testnet-rc5-20261102':
        check_universal_feature_version(texts['core/primitives-core/src/version.rs'], universal_version)
        view_fields = check_selected_protocol_view_fields(texts['core/parameters/src/view.rs'])
    if run_wabt('wasm-validate', ['--version']).stdout.strip() != WABT_VERSION:
        raise ValueError('unexpected WABT version')
    # Source nearcore 2.14.0 disables SIMD and multi-value, while allowing
    # selected proposal features at these protocol versions. This WABT check is
    # intentionally partial; it does not implement nearcore's validator.
    flags = ['--disable-simd', '--disable-multi-value']
    # WABT must analyze the verified bytes, not reopen a mutable input path.
    # A private temporary copy is removed after the offline tools finish.
    with tempfile.TemporaryDirectory(prefix='bouncer-v11-static-') as directory:
        snapshot = pathlib.Path(directory) / 'artifact.wasm'
        fd = os.open(snapshot, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        run_wabt('wasm-validate', [*flags, str(snapshot)])
        negative = run_wabt('wasm-validate', [*flags, '--disable-bulk-memory', str(snapshot)], expected=1)
        if 'unexpected opcode: 0xfc 0xa' not in negative.stderr:
            raise ValueError('unexpected bulk-memory-disabled validation result')
        details = run_wabt('wasm-objdump', ['-x', str(snapshot)]).stdout
    imports = parse_wabt_details(details)
    declarations = parse_nearcore_declarations(texts['runtime/near-vm-runner/src/imports.rs'])
    gates = compare_host_abi(imports, declarations)
    if len(imports) != 41 or gates != dict(sorted(EXPECTED_GATE_COUNTS.items())):
        raise ValueError('host import inventory differs from the exact reviewed artifact')
    report = {
        'status': 'STATIC_COMPATIBILITY_INDICATION_ONLY',
        'artifact_sha256': EXPECTED_WASM_SHA256,
        'artifact_bytes': len(data),
        'nearcore_source_commit': source_commit,
        'nearcore_pinned_source_sha256': source_hashes,
        'wabt_version': WABT_VERSION,
        'wabt_validation': {'simd_and_multivalue_disabled': 'PASS',
                            'bulk_memory_also_disabled': 'FAILS_ON_MEMORY_COPY_AS_EXPECTED'},
        'nearcore_selected_protocol_feature_diffs': versions,
        'env_function_imports_compared': len(imports),
        'host_signature_mismatches': 0,
        'import_declaration_gates': gates,
        'observed_network_state_checked': False,
        'nearcore_runtime_executed': False,
        'all_protocol_or_gas_limits_verified': False,
        'source_to_binary_provenance_verified': False,
        'independent_security_audit': False,
        'deployment_or_transaction_performed': False,
        'scope': ('static checks of one pinned WASM and selected nearcore 2.14.0 source files; not runtime compatibility or an audit'
                  if profile == 'release-2.14.0' else
                  'static checks of one pinned WASM and selected testnet rc.5 source files; not runtime compatibility or an audit'),
    }
    if view_fields is not None:
        report['nearcore_selected_protocol_view_boolean_fields'] = view_fields
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wasm', required=True, type=pathlib.Path, help='exact recovered 536,325-byte V11 WASM')
    parser.add_argument('--nearcore-dir', required=True, type=pathlib.Path, help='local source files for the selected pinned profile')
    parser.add_argument('--source-profile', choices=tuple(SOURCE_PROFILES), default='release-2.14.0',
                        help='pinned source profile (default: release-2.14.0)')
    args = parser.parse_args()
    try:
        report = inspect(args.wasm, args.nearcore_dir, args.source_profile)
    except (ValueError, UnicodeError, OSError) as exc:
        print(f'Static compatibility check blocked: {exc}', file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
