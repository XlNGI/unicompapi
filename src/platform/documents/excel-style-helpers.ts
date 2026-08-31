import type ExcelJS from 'exceljs';
import { DEFAULT_OFFICE_THEME } from '../../application/office-theme';

export interface ExcelStyleOptions {
  readonly freezeHeader?: boolean;
  readonly autoFilter?: boolean;
  readonly zebraStripe?: boolean;
  readonly boldHeader?: boolean;
  readonly fitColumns?: boolean;
}

export function applyExcelTableStyle(
  worksheet: ExcelJS.Worksheet,
  headerRow: number,
  dataStartRow: number,
  dataEndRow: number,
  columnCount: number,
  options: ExcelStyleOptions = {}
): void {
  const {
    freezeHeader = true,
    autoFilter = true,
    zebraStripe = true,
    boldHeader = true,
    fitColumns = true
  } = options;

  const theme = DEFAULT_OFFICE_THEME;

  // 冻结首行
  if (freezeHeader && headerRow > 0) {
    worksheet.views = [{ state: 'frozen', ySplit: headerRow }];
  }

  // 表头样式
  const headerRowObj = worksheet.getRow(headerRow);
  headerRowObj.eachCell((cell) => {
    if (boldHeader) {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: theme.table.headerFill.replace('#', 'FF') }
    };
    cell.border = {
      top: { style: 'thin' },
      bottom: { style: 'thin' },
      left: { style: 'thin' },
      right: { style: 'thin' }
    };
  });

  // 斑马纹
  if (zebraStripe && dataStartRow <= dataEndRow) {
    for (let rowNum = dataStartRow; rowNum <= dataEndRow; rowNum++) {
      const row = worksheet.getRow(rowNum);
      const isEven = (rowNum - dataStartRow) % 2 === 0;
      const fillColor = isEven
        ? theme.table.zebraEvenFill
        : theme.table.zebraOddFill;
      if (fillColor !== '#FFFFFF') {
        row.eachCell((cell) => {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: fillColor.replace('#', 'FF') }
          };
        });
      }
    }
  }

  // 自动筛选
  if (autoFilter && columnCount > 0) {
    worksheet.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: headerRow, column: columnCount }
    };
  }

  // 列宽自适应
  if (fitColumns) {
    worksheet.columns.forEach((column, idx) => {
      if (!column.width) {
        let maxLength = 10;
        const columnLetter = String.fromCharCode(65 + idx);
        worksheet.getColumn(columnLetter).eachCell?.({ includeEmpty: false }, (cell) => {
          const cellValue = cell.value?.toString() || '';
          maxLength = Math.max(maxLength, cellValue.length);
        });
        column.width = Math.min(maxLength + 2, 50);
      }
    });
  }
}

export function applyNumberFormat(
  cell: ExcelJS.Cell,
  dataType?: 'text' | 'number' | 'date' | 'currency'
): void {
  if (!dataType) return;

  switch (dataType) {
    case 'number':
      cell.numFmt = '#,##0.00';
      break;
    case 'currency':
      cell.numFmt = '¥#,##0.00';
      break;
    case 'date':
      cell.numFmt = 'yyyy-mm-dd';
      break;
    case 'text':
    default:
      cell.numFmt = '@';
      break;
  }
}
