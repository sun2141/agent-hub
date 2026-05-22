// src/projects.js
// 프로젝트 목록 정의 — 여기서만 관리

import path from 'path';

const PROJECTS_ROOT = (process.env.PROJECTS_ROOT || '/home/agent/workspace')
  .split(',')[0]
  .trim() || '/home/agent/workspace';

function projectPath(name) {
  return path.join(PROJECTS_ROOT, name);
}

export const PROJECTS = [
  {
    id: 'palmoni',
    name: 'Palmoni',
    path: projectPath('palmoni'),
    stack: 'react-vite',
    description: '기도 중보 앱',
  },
  {
    id: 'facepick',
    name: 'FacePick',
    path: projectPath('facepick'),
    stack: 'nextjs',
    description: '얼굴 인식 서비스',
  },
  {
    id: 'pray-crawling',
    name: 'pray-crawling',
    path: projectPath('pray-crawling'),
    stack: 'unknown',
    description: '기도 데이터 크롤링',
  },
  {
    id: 'health-blog',
    name: 'Health Blog',
    path: projectPath('health-blog-automation'),
    stack: 'nodejs',
    description: '건강 블로그 자동화',
  },
  {
    id: 'agent-hub',
    name: 'Agent Hub',
    path: projectPath('agent-hub'),
    stack: 'nodejs',
    description: '에이전트 허브 시스템',
  },
];
