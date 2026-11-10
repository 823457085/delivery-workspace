import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDeploymentProjects, parseDeploymentLinks } from '../src/features/deployments/native-deployments';
const repository = 'aaaaaaaaaaaaaaaaaaaaaaaa/demo-project/demo';
const fixture = () => ({ id: `codeup.aliyun.com:${repository}`, name: 'demo', repository,
  projectUrl: `https://codeup.aliyun.com/${repository}/pipeline`,
  environments: [{ environment: 'pre', name: '预发流水线', url: 'https://flow.aliyun.com/pipelines/123/current' }] });

test('云效入口合并保留本地项目和 Jenkins 项目，不伪造缺失环境', () => {
  const native = parseDeploymentLinks([fixture(), { ...fixture(), id: `codeup.aliyun.com:${repository}-ios`, repository: `${repository}-ios`, projectUrl: `https://codeup.aliyun.com/${repository}-ios/pipeline`, environments: [] }]);
  const local = { id: fixture().id, name: '本地展示名称', repository, paths: ['/fixture'], branches: ['feature/fixture'] };
  const jenkins = { id: 'gitlab:other', name: 'Jenkins project', repository: 'other', paths: [], branches: [] };
  const result = mergeDeploymentProjects([local, jenkins], native);
  assert.equal(result.length, 3); assert.equal(result[0], local); assert.equal(result[1], jenkins);
  assert.deepEqual(native[1].environments, []); assert.deepEqual(result[2].paths, []);
});

test('只接受真实云效域名和明确流水线，拒绝凭据、伪装域名及项目/环境冲突', () => {
  for (const url of ['javascript:alert(1)', 'https://flow.aliyun.com.evil.test/pipelines/123/current', 'https://user:pass@flow.aliyun.com/pipelines/123/current', 'https://flow.aliyun.com/pipelines/123/current?token=fixture', 'https://flow.aliyun.com/403']) {
    assert.throws(() => parseDeploymentLinks([{ ...fixture(), environments: [{ ...fixture().environments[0], url }] }]));
  }
  assert.throws(() => parseDeploymentLinks([{ ...fixture(), id: 'mismatched-project' }]));
  assert.throws(() => parseDeploymentLinks([fixture(), fixture()]));
  assert.throws(() => parseDeploymentLinks([{ ...fixture(), environments: [...fixture().environments, ...fixture().environments] }]));
  assert.equal(parseDeploymentLinks([{ ...fixture(), environments: [{ ...fixture().environments[0], environment: 'test' }] }])[0].environments[0].environment, 'test');
  for (const environment of ['', '   ', 'x'.repeat(101), 'pre\nprod']) {
    assert.throws(() => parseDeploymentLinks([{ ...fixture(), environments: [{ ...fixture().environments[0], environment }] }]));
  }
  assert.throws(() => parseDeploymentLinks({}));
  assert.deepEqual(parseDeploymentLinks([]), []);
});
