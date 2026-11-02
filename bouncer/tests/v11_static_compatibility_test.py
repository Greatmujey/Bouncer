"""Offline static-review parser regressions; no RPC or transaction."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'v11-static-compatibility.py'
spec = importlib.util.spec_from_file_location('v11_static_compatibility', SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

SOURCE = '''
  plain<[idx: u64] -> [u64]>,
  #[universal_accounts] newer<[promise: u64, state_len: u64, state_ptr: u64, amount: u64] -> []>,
'''
DETAILS = '''
Type[2]:
 - type[0] (i64) -> i64
 - type[1] (i64, i64, i64, i64) -> nil
Import[2]:
 - func[0] sig=0 <env.plain> <- env.plain
 - func[1] sig=1 <env.newer> <- env.newer
Function[1]:
 - func[2] sig=0
'''


class HostAbiTests(unittest.TestCase):
    def test_host_signatures_and_feature_gate_match(self):
        imports = mod.parse_wabt_details(DETAILS)
        declarations = mod.parse_nearcore_declarations(SOURCE)
        self.assertEqual(mod.compare_host_abi(imports, declarations),
                         {'ungated_declaration': 1, 'universal_accounts': 1})
        self.assertEqual(imports['newer'], (('i64', 'i64', 'i64', 'i64'), ()))

    def test_wrong_signature_or_missing_host_cannot_pass(self):
        declarations = mod.parse_nearcore_declarations(SOURCE)
        imports = mod.parse_wabt_details(DETAILS)
        for change in (
            lambda i: i.update({'newer': (('i32',), ())}),
            lambda i: i.update({'newer': (('i64', 'i64', 'i64', 'i64'), ('i64',))}),
            lambda i: i.update({'unrecognized': ((), ())}),
        ):
            altered = dict(imports)
            change(altered)
            with self.assertRaises(ValueError):
                mod.compare_host_abi(altered, declarations)

    def test_malformed_duplicate_or_non_env_imports_fail(self):
        for changed in (
            DETAILS.replace('<env.newer> <- env.newer', '<env.newer> <- evil.newer'),
            DETAILS.replace('Import[2]', 'Import[3]'),
            DETAILS.replace('<env.newer> <- env.newer', '<env.plain> <- env.plain'),
            DETAILS.replace('Function[1]:', ' - memory[0] pages: initial=1 <- env.memory\nFunction[1]:'),
            DETAILS.replace('sig=1 <env.newer>', 'sig=99 <env.newer>'),
            DETAILS.replace(' - type[1]', ' - type[0]'),
        ):
            with self.assertRaises(ValueError):
                mod.parse_wabt_details(changed)
        with self.assertRaises(ValueError):
            mod.parse_nearcore_declarations(SOURCE + '\n plain<[a: u64] -> [u64]>,')

    def test_selected_config_checks_flags_in_both_bases_and_each_diff(self):
        root = 'core/parameters/res/runtime_configs/'
        names = {'global_contract_host_fns': 78, 'reftypes_bulk_memory': 84,
                 'gas_key_host_fns': 85, 'universal_accounts': 88}
        base = ''.join(f'{name}: false\n' for name in names)
        files = {root + 'parameters.yaml': base, root + 'parameters_testnet.yaml': base}
        files.update({root + str(version) + '.yaml': f'{name}: {{ old: false, new: true }}\n'
                      for name, version in names.items()})
        self.assertEqual(mod.check_selected_config(files), names)
        for key in files:
            altered = dict(files)
            altered[key] = altered[key].replace('false', 'true', 1)
            with self.assertRaises(ValueError, msg=key):
                mod.check_selected_config(altered)

    def test_regular_file_pinning_rejects_substitution_symlink_and_oversize(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'blob'
            source.write_bytes(b'pinned')
            digest = hashlib.sha256(b'pinned').hexdigest()
            self.assertEqual(mod.read_pinned(source, digest, 12), b'pinned')
            with self.assertRaises(ValueError):
                mod.read_pinned(source, '0' * 64, 12)
            with self.assertRaises(ValueError):
                mod.read_pinned(source, digest, 5)
            link = root / 'link'
            link.symlink_to(source)
            with self.assertRaises(ValueError):
                mod.read_pinned(link, digest, 12)
            with self.assertRaises(ValueError):
                mod.read_pinned(root, digest, 12)

    def test_unexpected_wabt_failure_is_not_diagnosed_as_compatible(self):
        with self.assertRaises(ValueError):
            mod.run_wabt('wasm-validate', ['--not-a-real-wabt-flag'])

    @unittest.skipUnless(os.environ.get('BOUNCER_V11_WASM_PATH') and os.environ.get('BOUNCER_NEARCORE_SOURCE_DIR'),
                         'set the local exact V11 and pinned nearcore source paths')
    def test_actual_pinned_artifact_and_sources(self):
        result = mod.inspect(Path(os.environ['BOUNCER_V11_WASM_PATH']), Path(os.environ['BOUNCER_NEARCORE_SOURCE_DIR']))
        self.assertEqual(result['env_function_imports_compared'], 41)
        self.assertEqual(result['host_signature_mismatches'], 0)
        self.assertEqual(result['import_declaration_gates'], dict(sorted(mod.EXPECTED_GATE_COUNTS.items())))
        self.assertEqual(result['nearcore_selected_protocol_feature_diffs']['universal_accounts'], 88)
        for flag in ('nearcore_runtime_executed', 'source_to_binary_provenance_verified', 'independent_security_audit',
                     'deployment_or_transaction_performed'):
            self.assertFalse(result[flag], flag)


if __name__ == '__main__':
    unittest.main()
