import PptxGenJS from 'pptxgenjs';
import type { PresentationRenderPlan, PresentationRenderPlanElement } from '../../domain/entities/presentation-render-plan';
import type { PresentationRenderAsset } from './presentation-render-assets';

/** Writes an already validated Render Plan without choosing page geometry or visual hierarchy. */
export function renderPresentationRenderPlan(pptx: PptxGenJS, plan: PresentationRenderPlan, assets: readonly PresentationRenderAsset[] = []): void {
  for (const page of plan.pages) {
    const slide = pptx.addSlide();
    slide.background = { color: page.backgroundColor };
    for (const element of [...page.elements].sort((left, right) => left.zIndex - right.zIndex)) renderElement(slide, element, assets);
  }
}

function renderElement(slide: PptxGenJS.Slide, element: PresentationRenderPlanElement, assets: readonly PresentationRenderAsset[]): void {
  const { x, y, width: w, height: h } = element.geometry;
  const { style, content } = element;
  const objectName = `UniComp Render ${element.renderId}`;
  if (content.type === 'text') {
    const runs: PptxGenJS.TextProps[] = [];
    let offset = 0;
    for (const span of style.textSpans ?? []) {
      if (span.start > offset) runs.push({ text: content.text.slice(offset, span.start), options: {} });
      runs.push({ text: content.text.slice(span.start, span.end), options: { ...span.style,
        ...(span.style.fontWeight === undefined ? {} : { bold: span.style.fontWeight === 700 }) } });
      offset = span.end;
    }
    if (offset < content.text.length) runs.push({ text: content.text.slice(offset), options: {} });
    slide.addText(style.textSpans?.length ? runs : content.text, {
      objectName, x, y, w, h,
      fontFace: style.fontFamily,
      fontSize: style.fontSize,
      bold: style.fontWeight === undefined ? style.bold : style.fontWeight >= 600,
      ...(style.lineSpacingMultiple === undefined ? {} : { lineSpacingMultiple: style.lineSpacingMultiple }),
      ...(style.charSpacing === undefined ? {} : { charSpacing: style.charSpacing }),
      color: style.color,
      ...(style.fill ? { fill: { color: style.fill } } : {}),
      ...(style.borderWidth && style.borderColor ? { line: { color: style.borderColor, width: style.borderWidth } } : {}),
      align: style.alignment,
      valign: style.verticalAlignment,
      margin: 0,
      wrap: true,
      breakLine: false,
      paraSpaceAfter: 0,
      fit: 'none'
    });
    return;
  }
  if (content.type === 'image') {
    const asset = assets.find(asset => asset.assetKey === content.assetKey);
    if (!asset || asset.digest !== content.assetDigest || asset.aspectRatio !== content.aspectRatio) throw new TypeError('design_asset_binding_mismatch');
    const boxRatio = w / h;
    const contain = asset.aspectRatio > boxRatio ? { x, y: y + (h - w / asset.aspectRatio) / 2, w, h: w / asset.aspectRatio }
      : { x: x + (w - h * asset.aspectRatio) / 2, y, w: h * asset.aspectRatio, h };
    slide.addImage({ objectName, data: asset.data, rounding: content.imageMask === 'ellipse', ...(content.imageFit === 'contain' ? contain : { x, y, w, h,
      sizing: { type: 'cover', w, h } }) });
    return;
  }
  if (content.type === 'table') {
    const headerFill = style.tableHeaderFill ?? style.fill ?? 'FFFFFF';
    const bodyFill = style.tableBodyFill ?? style.fill ?? 'FFFFFF';
    slide.addTable([
      content.header.map(text => ({ text, options: { bold: style.fontWeight === undefined ? true : style.fontWeight >= 600, color: style.tableHeaderColor ?? style.color, fill: { color: headerFill } } })),
      ...content.rows.map(row => row.map(text => ({ text, options: { color: style.color, fill: { color: bodyFill },
        bold: style.fontWeight === undefined ? style.bold : style.fontWeight >= 600 } })))
    ], {
      objectName, x, y, w, h,
      fontFace: style.fontFamily,
      fontSize: style.fontSize,
      align: style.alignment,
      color: style.color,
      border: { pt: style.borderWidth ?? 0.6, color: style.borderColor ?? style.color },
      margin: 0.06,
      valign: style.verticalAlignment,
      autoPage: false,
      autoPageRepeatHeader: false
    });
    return;
  }
  if (content.type === 'chart') {
    const chartType = new PptxGenJS().ChartType[style.chartKind ?? content.chartKind];
    slide.addChart(chartType, [{
      name: content.title ?? 'Data',
      labels: content.data.map(item => item.label),
      values: content.data.map(item => item.value)
    }], {
      objectName, x, y, w, h,
      showTitle: Boolean(content.title),
      title: content.title ?? '',
      titleColor: style.color,
      titleFontFace: style.fontFamily, titleFontSize: style.fontSize,
      catAxisLabelFontFace: style.fontFamily, catAxisLabelFontSize: style.fontSize,
      valAxisLabelFontFace: style.fontFamily, valAxisLabelFontSize: style.fontSize,
      legendFontFace: style.fontFamily, legendFontSize: style.fontSize,
      dataLabelFontFace: style.fontFamily, dataLabelFontSize: style.fontSize,
      ...(style.fill ? { chartArea: { fill: { color: style.fill } }, plotArea: { fill: { color: style.fill } } } : {}),
      showLegend: style.showLegend,
      legendColor: style.color,
      showValue: style.showValues,
      dataLabelColor: style.color,
      catAxisLabelColor: style.mutedColor ?? style.color,
      valAxisLabelColor: style.mutedColor ?? style.color,
      chartColors: [...(style.chartColors ?? [style.color])]
    });
    return;
  }
  if (content.type === 'shape') {
    slide.addShape(content.shapeKind, {
      objectName, x, y, w, h,
      ...(content.shapeKind === 'line' ? { line: { color: style.borderColor ?? style.color, width: style.borderWidth ?? 1 } } : {
        fill: { color: style.fill ?? style.color },
        line: { color: style.borderColor ?? style.color, width: style.borderWidth ?? 1 }
      })
    });
    return;
  }
  throw new TypeError('unsupported_render_plan_element');
}
