/** Only user requirements are eligible; attachment text cannot enable image transmission. */
export function isConversationImageRequest(text: string): boolean {
  if (/(?:不要|无需|不需要|别)\s*(?:分析|识别|读取|描述)|(?:只|仅)(?:用|作为).*插图/u.test(text)) return false;
  return /(?:分析|识别|描述|解读|查看|看看|看一下|提取|读取|翻译|总结)[\s\S]{0,24}(?:图片|图像|照片|截图|这张图|这幅图)|(?:图片|图像|照片|截图|这张图|这幅图|图中|图里|图上)[\s\S]{0,24}(?:是什么|有什么|内容|文字|说明|含义|颜色|分析|识别|描述|解读)|\b(?:analy[sz]e|describe|read|explain|inspect)\b[\s\S]{0,30}\b(?:image|picture|photo|screenshot)\b/iu.test(text);
}

export function declinesConversationImageInput(text: string): boolean {
  return /(?:不要|无需|不需要|不用|忽略|别)[\s\S]{0,12}(?:图片|图像|照片|截图|看图)|(?:without|ignore)[\s\S]{0,16}(?:image|photo|picture)/iu.test(text);
}
