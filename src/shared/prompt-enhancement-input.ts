export interface PromptEnhancementContentSourceContext {
  readonly kind: string;
  readonly includeInPrompt?: boolean;
}

export interface ImagePromptEnhancementContentSource {
  readonly contextReferences: readonly PromptEnhancementContentSourceContext[];
  readonly input?: {
    readonly purpose?: string;
    readonly region?: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  };
  readonly editing?: {
    readonly mustKeep: readonly string[];
    readonly mustChange: readonly string[];
    readonly prohibited: readonly string[];
  };
  readonly imageToPrompt?: {
    readonly purpose: string;
    readonly requirements: readonly string[];
  };
}

export interface VideoPromptEnhancementContentSource {
  readonly contextReferences: readonly PromptEnhancementContentSourceContext[];
  readonly textToVideo?: {
    readonly sourceKind: string;
    readonly shots: readonly {
      readonly order: number;
      readonly description: string;
      readonly action?: string;
      readonly cameraMovement?: string;
      readonly pace?: string;
      readonly depthOfField?: string;
    }[];
  };
  readonly imageToVideo?: {
    readonly mustKeep: readonly string[];
    readonly allowedChanges: readonly string[];
    readonly prohibited: readonly string[];
    readonly subjectAction: string;
    readonly cameraMovement: string;
    readonly pace: string;
    readonly depthOfField: string;
  };
}

export interface PromptEnhancementContentResult {
  readonly required: boolean;
  readonly text: string;
}

export function composeImagePromptEnhancementInput(
  source: ImagePromptEnhancementContentSource
): PromptEnhancementContentResult {
  const sections: string[] = [];
  const purpose = source.input?.purpose?.trim();
  if (purpose) sections.push(`图片用途：${purpose}`);
  if (source.input?.region) {
    sections.push(
      `编辑区域：左 ${percent(source.input.region.x)} · 上 ${percent(source.input.region.y)} · 宽 ${percent(source.input.region.width)} · 高 ${percent(source.input.region.height)}`
    );
  }
  if (source.editing) {
    pushListSection(sections, '必须保留', source.editing.mustKeep);
    pushListSection(sections, '必须修改', source.editing.mustChange);
    pushListSection(sections, '禁止出现', source.editing.prohibited);
  }
  if (source.imageToPrompt) {
    const targetPurpose = source.imageToPrompt.purpose.trim();
    if (targetPurpose) sections.push(`目标用途：${targetPurpose}`);
    pushListSection(sections, '补充要求', source.imageToPrompt.requirements);
  }
  const text = sections.join('\n\n');
  return {
    required: activeContextCount(source.contextReferences) > 0 || text.trim().length > 0,
    text
  };
}

export function composeVideoPromptEnhancementInput(
  source: VideoPromptEnhancementContentSource
): PromptEnhancementContentResult {
  const sections: string[] = [];
  if (source.textToVideo) {
    if (source.textToVideo.sourceKind === 'long_form') {
      sections.push('来源类型：长文本脚本');
    }
    for (const shot of source.textToVideo.shots) {
      const details = [
        `镜头 ${shot.order}：${shot.description.trim()}`,
        shot.action?.trim() ? `动作：${shot.action.trim()}` : undefined,
        shot.cameraMovement?.trim() ? `镜头运动：${shot.cameraMovement.trim()}` : undefined,
        shot.pace?.trim() ? `节奏：${shot.pace.trim()}` : undefined,
        shot.depthOfField?.trim() ? `景深：${shot.depthOfField.trim()}` : undefined
      ].filter((item): item is string => Boolean(item));
      if (details.length > 0) sections.push(details.join('\n'));
    }
  }
  if (source.imageToVideo) {
    pushListSection(sections, '必须保持', source.imageToVideo.mustKeep);
    pushListSection(sections, '允许变化', source.imageToVideo.allowedChanges);
    pushListSection(sections, '禁止变化', source.imageToVideo.prohibited);
    pushSingleField(sections, '主体动作', source.imageToVideo.subjectAction);
    pushSingleField(sections, '镜头运动', source.imageToVideo.cameraMovement);
    pushSingleField(sections, '节奏', source.imageToVideo.pace);
    pushSingleField(sections, '景深', source.imageToVideo.depthOfField);
  }
  const text = sections.join('\n\n');
  return {
    required: activeContextCount(source.contextReferences) > 0 || text.trim().length > 0,
    text
  };
}

function activeContextCount(
  references: readonly PromptEnhancementContentSourceContext[]
): number {
  return references.filter(
    (reference) =>
      reference.kind === 'project_context' && reference.includeInPrompt === true
  ).length;
}

function pushListSection(
  sections: string[],
  label: string,
  values: readonly string[]
): void {
  const lines = values.map((value) => value.trim()).filter(Boolean);
  if (lines.length > 0) sections.push(`${label}：\n${lines.join('\n')}`);
}

function pushSingleField(
  sections: string[],
  label: string,
  value: string
): void {
  const normalized = value.trim();
  if (normalized) sections.push(`${label}：${normalized}`);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
