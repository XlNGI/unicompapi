export const imageCreationModes = [
  {
    id: 'quick-image',
    workspaceMode: 'quick_image',
    label: '快速生图',
    description: '以最少配置开始图片创作。',
    emptyTitle: '还没有快速生图草稿',
    emptyDescription: '可先创建项目内本地草稿；参考图、能力预检和生成将在后续契约接入。',
    icon: '快'
  },
  {
    id: 'professional-image',
    workspaceMode: 'professional_image',
    label: '专业生图',
    description: '为图片创作保留更完整的控制空间。',
    emptyTitle: '还没有专业生图草稿',
    emptyDescription: '可先创建项目内本地草稿；上下文、动态参数和提交将在后续契约接入。',
    icon: '专'
  },
  {
    id: 'image-understanding',
    workspaceMode: 'image_understanding',
    label: '图片识别',
    description: '分析本地图片并整理可复用的上下文。',
    emptyTitle: '还没有图片识别草稿',
    emptyDescription: '可先创建项目内本地草稿；选择图片不会自动上传或分析。',
    icon: '识'
  },
  {
    id: 'image-editing',
    workspaceMode: 'image_editing',
    label: '图片编辑',
    description: '为图片编辑保留独立的工作入口。',
    emptyTitle: '还没有图片编辑草稿',
    emptyDescription: '可先创建项目内本地草稿；当前不会读取或覆盖原始图片。',
    icon: '编'
  },
  {
    id: 'image-to-prompt',
    workspaceMode: 'image_to_prompt',
    label: '图片转提示词',
    description: '从图片中整理可检查的提示词草稿。',
    emptyTitle: '还没有图片转提示词草稿',
    emptyDescription: '可先创建项目内本地草稿；选择图片和分析能力将在后续契约接入。',
    icon: '词'
  }
] as const;

export const videoCreationModes = [
  {
    id: 'quick-video',
    workspaceMode: 'quick_video',
    label: '快速视频',
    description: '以最少配置开始视频创作。',
    emptyTitle: '还没有快速视频草稿',
    emptyDescription: '可先创建项目内本地草稿；选择素材不会自动上传或生成。',
    icon: '快'
  },
  {
    id: 'text-to-video',
    workspaceMode: 'text_to_video',
    label: '文生视频',
    description: '从文本上下文整理视频创作草稿。',
    emptyTitle: '还没有文生视频草稿',
    emptyDescription: '可先创建项目内本地草稿；上下文、镜头方案和提交仍等待受控端口。',
    icon: '文'
  },
  {
    id: 'image-to-video',
    workspaceMode: 'image_to_video',
    label: '图生视频',
    description: '从已选择的图片素材整理视频创作草稿。',
    emptyTitle: '还没有图生视频草稿',
    emptyDescription: '可先创建项目内本地草稿；图片槽位与数量必须等待动态能力事实。',
    icon: '图'
  },
  {
    id: 'video-editing',
    label: '基础编辑',
    description: '为单轨、非破坏式视频编辑保留独立入口。',
    emptyTitle: '基础编辑尚未接入',
    emptyDescription: '当前不修改源文件；编辑草稿、代理预览和本地导出将在完成技术架构后实现。',
    icon: '编'
  }
] as const;

export type ImageCreationModeId = (typeof imageCreationModes)[number]['id'];
export type ImageCreationMode = (typeof imageCreationModes)[number];
export type VideoCreationModeId = (typeof videoCreationModes)[number]['id'];
export type VideoCreationMode = (typeof videoCreationModes)[number];
