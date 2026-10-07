import PptxGenJS from 'pptxgenjs';
import type { PresentationRenderPlan, PresentationRenderPlanElement } from '../../domain/entities/presentation-render-plan';

/** Writes an already validated Render Plan without choosing page geometry or visual hierarchy. */
export function renderPresentationRenderPlan(pptx: PptxGenJS, plan: PresentationRenderPlan): void {
  for (const page of plan.pages) {
    const slide = pptx.addSlide();
    slide.background = { color: page.backgroundColor };
    for (const element of [...page.elements].sort((left, right) => left.zIndex - right.zIndex)) renderElement(slide, element);
  }
}

function renderElement(slide: PptxGenJS.Slide, element: PresentationRenderPlanElement): void {
  const { x, y, width: w, height: h } = element.geometry;
  const { style, content } = element;
  const objectName = `UniComp Render ${element.renderId}`;
  if (content.type === 'text') {
    slide.addText(content.text, {
      objectName, x, y, w, h,
      fontFace: style.fontFamily,
      fontSize: style.fontSize,
      bold: style.bold,
      color: style.color,
      ...(style.fill ? { fill: { color: style.fill } } : {}),
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
  if (content.type === 'table') {
    const headerFill = style.tableHeaderFill ?? style.fill ?? 'FFFFFF';
    const bodyFill = style.tableBodyFill ?? style.fill ?? 'FFFFFF';
    slide.addTable([
      content.header.map(text => ({ text, options: { bold: true, color: style.tableHeaderColor ?? style.color, fill: { color: headerFill } } })),
      ...content.rows.map(row => row.map(text => ({ text, options: { color: style.color, fill: { color: bodyFill } } })))
    ], {
      objectName, x, y, w, h,
      fontFace: style.fontFamily,
      fontSize: style.fontSize,
      color: style.color,
      border: { pt: 0.6, color: style.borderColor ?? style.color },
      margin: 0.06,
      valign: style.verticalAlignment,
      autoPage: false,
      autoPageRepeatHeader: false
    });
    return;
  }
  if (content.type === 'chart') {
    const chartType = new PptxGenJS().ChartType[content.chartKind];
    slide.addChart(chartType, [{
      name: content.title ?? 'Data',
      labels: content.data.map(item => item.label),
      values: content.data.map(item => item.value)
    }], {
      objectName, x, y, w, h,
      showTitle: Boolean(content.title),
      title: content.title ?? '',
      titleColor: style.color,
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
  throw new TypeError('unsupported_render_plan_element');
}
