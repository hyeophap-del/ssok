// 업데이트 파일의 서명을 확인하는 공개 키.
// 짝이 되는 개인 키는 저장소 밖(%USERPROFILE%\.ssok-release\update-key.pem)에만 있고, 릴리스할 때 서명에 쓴다.
export const UPDATE_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAxIrqOa26D3epRsK+u8zOiezWVLF7g1HcxRkP6Lph+3M=\n-----END PUBLIC KEY-----\n';
