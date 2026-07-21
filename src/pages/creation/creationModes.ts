export const imageCreationModes = [
  {
    id: 'quick-image',
    label: '快速生图',
    description: '以最少配置开始图片创作。',
    emptyTitle: '快速生图尚未接入',
    emptyDescription: '当前只保留页面骨架；可用服务、模型和参数将在验证后动态提供。',
    icon: '快'
  },
  {
    id: 'professional-image',
    label: '专业生图',
    description: '为图片创作保留更完整的控制空间。',
    emptyTitle: '专业生图尚未接入',
    emptyDescription: '当前不创建任务；参数、素材范围和费用将在真实能力接入后展示。',
    icon: '专'
  },
  {
    id: 'image-understanding',
    label: '图片识别',
    description: '分析本地图片并整理可复用的上下文。',
    emptyTitle: '图片识别尚未接入',
    emptyDescription: '当前不上传或处理文件；本地文件校验和分析能力将在后续阶段实现。',
    icon: '识'
  },
  {
    id: 'image-editing',
    label: '图片编辑',
    description: '为图片编辑保留独立的工作入口。',
    emptyTitle: '图片编辑尚未接入',
    emptyDescription: '当前不修改原始文件；非破坏式编辑和导出将在后续阶段实现。',
    icon: '编'
  },
  {
    id: 'image-to-prompt',
    label: '图片转提示词',
    description: '从图片中整理可检查的提示词草稿。',
    emptyTitle: '图片转提示词尚未接入',
    emptyDescription: '当前只保留分析占位；原始输入、系统补充和最终提示词将在后续阶段分别展示。',
    icon: '词'
  }
] as const;

export const videoCreationModes = [
  {
    id: 'quick-video',
    label: '快速视频',
    description: '以最少配置开始视频创作。',
    emptyTitle: '快速视频尚未接入',
    emptyDescription: '当前不创建任务；可用能力、时长和费用将在验证后动态提供。',
    icon: '快'
  },
  {
    id: 'text-to-video',
    label: '文生视频',
    description: '从文本上下文整理视频创作草稿。',
    emptyTitle: '文生视频尚未接入',
    emptyDescription: '当前只保留草稿入口；提交任务前的外发范围和费用确认将在后续阶段实现。',
    icon: '文'
  },
  {
    id: 'image-to-video',
    label: '图生视频',
    description: '从已选择的图片素材整理视频创作草稿。',
    emptyTitle: '图生视频尚未接入',
    emptyDescription: '当前不读取未明确选择的素材，也不创建远端任务。',
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
export type VideoCreationModeId = (typeof videoCreationModes)[number]['id'];
