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

export const secondaryNavigationItems = [
  {
    id: 'quick-image',
    parentId: 'image-creation',
    label: '快速生图',
    description: '快速生图页面骨架，具体创作流程将在后续阶段接入。'
  },
  {
    id: 'professional-image',
    parentId: 'image-creation',
    label: '专业生图',
    description: '专业生图页面骨架，具体创作流程将在后续阶段接入。'
  },
  {
    id: 'image-understanding',
    parentId: 'image-creation',
    label: '图片识别',
    description: '图片识别页面骨架，具体识别能力将在后续阶段接入。'
  },
  {
    id: 'image-editing',
    parentId: 'image-creation',
    label: '图片编辑',
    description: '图片编辑页面骨架，具体编辑能力将在后续阶段接入。'
  },
  {
    id: 'image-to-prompt',
    parentId: 'image-creation',
    label: '图片转提示词',
    description: '图片转提示词页面骨架，具体分析能力将在后续阶段接入。'
  },
  {
    id: 'quick-video',
    parentId: 'video-creation',
    label: '快速视频',
    description: '快速视频页面骨架，具体创作流程将在后续阶段接入。'
  },
  {
    id: 'text-to-video',
    parentId: 'video-creation',
    label: '文生视频',
    description: '文生视频页面骨架，具体创作流程将在后续阶段接入。'
  },
  {
    id: 'image-to-video',
    parentId: 'video-creation',
    label: '图生视频',
    description: '图生视频页面骨架，具体创作流程将在后续阶段接入。'
  },
  {
    id: 'video-editing',
    parentId: 'video-creation',
    label: '基础编辑',
    description: '视频基础编辑页面骨架，具体编辑能力将在后续阶段接入。'
  }
] as const;

export type SecondaryNavigationItemId =
  (typeof secondaryNavigationItems)[number]['id'];

export function getSecondaryNavigationItems(parentId: NavigationItemId) {
  return secondaryNavigationItems.filter((item) => item.parentId === parentId);
}
