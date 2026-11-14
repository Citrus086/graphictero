/**
 * uv 找不到时的提示（主进程报错与渲染层文案共用）。
 * Finder 启动的 App 只有最小 PATH，Homebrew / 官方安装脚本装的 uv 可能不在里面，
 * 主进程会先查常见位置；都没有才用这段提示。
 */
export const UV_INSTALL_COMMAND = 'curl -LsSf https://astral.sh/uv/install.sh | sh'
export const UV_BREW_COMMAND = 'brew install uv'
/** 错误串里的固定标记，渲染层据此归类（不依赖完整文案） */
export const UV_NOT_FOUND_MARK = '找不到 uv'
export const UV_NOT_FOUND_MESSAGE = `${UV_NOT_FOUND_MARK}（MinerU 靠它安装和运行）。请在终端运行 ${UV_INSTALL_COMMAND} 或 ${UV_BREW_COMMAND} 安装后重试`
