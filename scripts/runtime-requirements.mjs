export const minimumNode = '22.13.0';

export function supportedNode(version = process.versions.node) {
  const actual = version.replace(/^v/, '').split('.').map(Number);
  const minimum = minimumNode.split('.').map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (!Number.isInteger(actual[index])) return false;
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export function requireSupportedNode() {
  if (!supportedNode()) {
    console.error(`需要 Node.js >= ${minimumNode}，当前为 ${process.version}。请先安装 Node.js 22 LTS 或更高版本。`);
    process.exit(1);
  }
}
