import test from 'node:test';
import assert from 'node:assert/strict';
import type os from 'node:os';
import { vpnGatewayConfig } from '../server/vpn-gateway.js';

const entry = (address: string, internal = false): os.NetworkInterfaceInfoIPv4 => ({ address, internal, family: 'IPv4', netmask: '255.255.255.0', mac: '', cidr: null });
const env = { DELIVERY_VPN_ADDRESS: '10.77.0.2', DELIVERY_VPN_CLIENTS: '10.77.0.3' };
const interfaces = { utun8: [entry(env.DELIVERY_VPN_ADDRESS)] };

test('VPN config requires explicit private IPv4 addresses and individual remote peers', () => {
  for (const address of ['', '0.0.0.0', '127.0.0.1', '8.8.8.8', '172.32.0.2', '::1', '10.77.0.2/24']) {
    assert.throws(() => vpnGatewayConfig({ ...env, DELIVERY_VPN_ADDRESS: address }, interfaces), /DELIVERY_VPN_ADDRESS/);
  }
  for (const clients of ['', ' ', '0.0.0.0', '127.0.0.1', '8.8.8.8', '::1', '10.77.0.0/24', '10.77.0.2', '10.77.0.3,']) {
    assert.throws(() => vpnGatewayConfig({ ...env, DELIVERY_VPN_CLIENTS: clients }, interfaces), /DELIVERY_VPN_CLIENTS/);
  }
  assert.throws(() => vpnGatewayConfig({}, interfaces), /DELIVERY_VPN_ADDRESS/);
  assert.throws(() => vpnGatewayConfig({ DELIVERY_VPN_ADDRESS: env.DELIVERY_VPN_ADDRESS }, interfaces), /DELIVERY_VPN_CLIENTS/);
});

test('VPN config refuses unassigned addresses, physical interfaces and internal interfaces', () => {
  for (const network of [{}, { en0: interfaces.utun8 }, { lo0: interfaces.utun8 }, { utun8: [entry('10.77.0.4')] }, { utun8: [entry(env.DELIVERY_VPN_ADDRESS, true)] }]) {
    assert.throws(() => vpnGatewayConfig(env, network), /请先连接私人 VPN/);
  }
});

test('VPN config binds only the selected active tunnel address and snapshots the peer list', () => {
  const config = vpnGatewayConfig({ ...env, DELIVERY_VPN_CLIENTS: ' 10.77.0.3,10.77.0.4,10.77.0.3 ' }, {
    en0: [entry('192.168.1.5')], utun0: [entry('10.10.0.2')], ...interfaces,
  });
  assert.deepEqual(config, { network: { address: '10.77.0.2', netmask: '255.255.255.0' }, clients: ['10.77.0.3', '10.77.0.4'] });
  for (const address of ['172.20.100.2', '172.31.0.2', '192.168.202.2']) {
    assert.equal(vpnGatewayConfig({ ...env, DELIVERY_VPN_ADDRESS: address }, { utun8: [entry(address)] }).network.address, address);
  }
});
