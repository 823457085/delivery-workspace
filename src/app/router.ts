import { createRouter, createWebHistory } from 'vue-router';
import ControlLayout from './layouts/ControlLayout.vue';

export const router = createRouter({ history: createWebHistory(), scrollBehavior: () => ({ top: 0 }), routes: [
  { path: '/lab', component: () => import('../pages/lab/index.vue') },
  { path: '/integration', component: () => import('../pages/integration/index.vue') },
  { path: '/', component: ControlLayout, children: [
    { path: '', redirect: '/agent' },
    { path: 'workbench', component: () => import('../pages/workbench/index.vue') },
    { path: 'agent', component: () => import('../pages/agent/index.vue'), meta: { immersive: true } },
    { path: 'refactor/api-integration', component: () => import('../pages/api-integration/index.vue') },
    { path: 'refactor/apex-bff-review', redirect: '/refactor/api-integration' },
    { path: 'overview', component: () => import('../pages/overview/index.vue') },
    { path: 'tasks/:mode(calendar|list|stats)', component: () => import('../pages/tasks/index.vue'), props: true },
    { path: 'projects', component: () => import('../pages/projects/index.vue') },
    { path: 'design', component: () => import('../pages/design/index.vue') },
    { path: 'delivery/:mode(plan|queue|runs)', component: () => import('../pages/delivery/index.vue'), props: true },
    { path: 'catchup/:mode(execution|merge|codex)', component: () => import('../pages/catchup/index.vue'), props: true },
    { path: 'settings', component: () => import('../pages/settings/index.vue') },
    { path: ':pathMatch(.*)*', redirect: '/overview' },
  ] },
] });
