use std::io::Write;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut out = |text: &str| {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{text}");
    };
    let mut err = |text: &str| {
        let mut stderr = std::io::stderr().lock();
        let _ = writeln!(stderr, "{text}");
    };
    let mut io = atlas_cli::Io {
        env: std::env::vars().collect(),
        stdout: &mut out,
        stderr: &mut err,
        connect: None,
    };
    let code = atlas_cli::run(&argv, &mut io);
    std::process::exit(code);
}
