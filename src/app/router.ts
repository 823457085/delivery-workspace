import { createRouter, createWebHistory, type RouteLocation } from 'vue-router';
import { legacyExecutionPaths, workspaceLocation, workspaceViews } from '../pages/agent/workspace-navigation';

const redirectWorkspace = (to: RouteLocation) => ({ ...workspaceLocation(to.path, to.query)!, hash: to.hash });

export const router = createRouter({ history: createWebHistory(), scrollBehavior: () => ({ top: 0 }), routes: [
  { path: '/', redirect: '/agent' },
  { path: '/agent', component: () => import('../pages/agent/index.vue') },
  ...workspaceViews.filter(view => !view.path.includes('?')).map(view => ({ path: view.path, redirect: redirectWorkspace })),
  ...Object.keys(legacyExecutionPaths).map(path => ({ path, redirect: redirectWorkspace })),
  { path: '/:pathMatch(.*)*', redirect: '/agent?view=today' },
] });
