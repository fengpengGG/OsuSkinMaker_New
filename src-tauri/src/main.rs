//! 入口。大部分逻辑放在 lib.rs 以便单元测试。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    osuskin_maker_lib::run()
}