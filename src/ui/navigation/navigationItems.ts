import {
  imageCreationModes,
  videoCreationModes,
  type ImageCreationModeId,
  type VideoCreationModeId
} from '../../pages/creation/creationModes';

export const navigationItems = [
  {
    id: 'chat',
    label: '对话',
    description: '用于独立问答、分析、整理和上下文沉淀。'
  },
  {
    id: 'projects',
    label: '项目',
    description: '用于管理素材、上下文、草稿、任务和作品。'
  },
  {
    id: 'image-creation',
    label: '图片创作',
    description: '图片创作页面骨架，具体创作流程将在后续阶段接入。'
  },
  {
    id: 'video-creation',
    label: '视频创作',
    description: '视频创作页面骨架，具体创作流程将在后续阶段接入。'
  },
  {
    id: 'tasks',
    label: '任务中心',
    description: '任务管理页面骨架，暂不展示业务数据。'
  },
  {
    id: 'library',
    label: '作品库',
    description: '本地作品管理页面骨架，暂不展示业务数据。'
  },
  {
    id: 'providers',
    label: '模型与服务商',
    description: '模型与服务商管理页面骨架，暂不连接后台服务。'
  },
  {
    id: 'settings',
    label: '本地设置',
    description: '本地应用设置页面骨架，具体设置项将在后续阶段接入。'
  }
] as const;

export type NavigationItemId = (typeof navigationItems)[number]['id'];

export const defaultNavigationItemId: NavigationItemId = navigationItems[0].id;

export type SecondaryNavigationItemId =
  | ImageCreationModeId
  | VideoCreationModeId;

interface SecondaryNavigationItem {
  id: SecondaryNavigationItemId;
  parentId: 'image-creation' | 'video-creation';
  label: string;
  description: string;
}

export const secondaryNavigationItems: readonly SecondaryNavigationItem[] = [
  ...imageCreationModes.map(({ id, label, description }) => ({
    id,
    parentId: 'image-creation' as const,
    label,
    description
  })),
  ...videoCreationModes.map(({ id, label, description }) => ({
    id,
    parentId: 'video-creation' as const,
    label,
    description
  }))
];

export function getSecondaryNavigationItems(parentId: NavigationItemId) {
  return secondaryNavigationItems.filter((item) => item.parentId === parentId);
}
