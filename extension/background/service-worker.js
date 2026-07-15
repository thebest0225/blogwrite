// 액션 아이콘 클릭 시 사이드패널이 열리도록 설정
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// (선택) 아이콘 클릭 시에도 명시적으로 열기
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    // setPanelBehavior가 이미 처리
  }
});
