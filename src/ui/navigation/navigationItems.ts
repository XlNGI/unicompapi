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
    description: '用于保存对话，并将明确选择的消息片段登记为项目上下文。'
  },
  {
    id: 'projects',
    label: '项目',
    description: '用于管理素材、上下文、草稿、任务和作品。'
  },
  {
    id: 'image-creation',
    label: '图片创作',
    description: '进入快速、专业、识别、编辑和图片转提示词工作区。'
  },
  {
    id: 'video-creation',
    label: '视频创作',
    description: '进入快速、文生、图生视频和基础编辑工作区。'
  },
  {
    id: 'tasks',
    label: '任务中心',
    description: '查看当前项目的真实任务、执行状态和详情。'
  },
  {
    id: 'library',
    label: '作品库',
    description: '查看经本地校验并已登记的图片、视频和导出作品。'
  },
  {
    id: 'providers',
    label: '模型与服务商',
    description: '管理服务商、连接、本机凭证、模型能力和路由。'
  },
  {
    id: 'settings',
    label: '本地设置',
    description: '管理本地应用的十类设置、诊断和更新状态。'
  }
] as const;

export type NavigationItemId = (typeof navigationItems)[number]['id'];

export const defaultNavigationItemId: NavigationItemId = 'projects';

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
