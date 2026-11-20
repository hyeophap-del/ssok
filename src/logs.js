// 실행 기록을 남에게 보낼 수 있게 다듬기: 접속 코드(휴대폰 주소의 k=…)를 가린다
export function redactLog(text, token) {
  let out = token ? text.split(token).join('●●●●') : text;
  out = out.replace(/([?&]k=)[A-Za-z0-9_-]+/g, '$1●●●●');
  return out;
}
