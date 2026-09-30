import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import solc from 'solc';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceName = 'contracts/HolderTestPayoutVault.sol';
const contractName = 'HolderTestPayoutVault';
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function compilePaymentContract() {
  const source = readFileSync(resolve(root, sourceName), 'utf8');
  const settings = { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'metadata', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } };
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { [sourceName]: { content: source } }, settings })));
  const errors = (output.errors || []).filter(error => error.severity === 'error');
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  const compiled = output.contracts[sourceName][contractName];
  const bytecode = `0x${compiled.evm.bytecode.object}`, deployedBytecode = `0x${compiled.evm.deployedBytecode.object}`;
  return { schemaVersion: 1, contractName, sourceName, testOnly: true, allowedChainIds: [46630, 31337],
    compilerVersion: solc.version(), evmVersion: settings.evmVersion, optimizer: settings.optimizer,
    abi: compiled.abi, bytecode, deployedBytecode, metadata: JSON.parse(compiled.metadata),
    checksums: { sourceSha256: sha256(source), bytecodeSha256: sha256(Buffer.from(bytecode.slice(2), 'hex')),
      deployedBytecodeSha256: sha256(Buffer.from(deployedBytecode.slice(2), 'hex')) } };
}

export function writePaymentArtifact(destination = resolve(root, 'payment-lab/contract.json')) {
  const artifact = compilePaymentContract();
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  return artifact;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const artifact = writePaymentArtifact();
  console.log(`${artifact.contractName}: ${artifact.compilerVersion}, ${artifact.evmVersion}, artifact written to payment-lab/contract.json`);
}
