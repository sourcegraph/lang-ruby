# typed: true
class BigFoo; extend T::Sig
  # Hey
  class LittleFoo1; extend T::Sig
    sig {params(num: Integer).returns(Integer)}
    def bar(num)
      3 + num
    end
  end

  # Hey
  class LittleFoo2; extend T::Sig
    sig {returns(Integer)}
    def bar
      a = BigFoo::LittleFoo1.new
      a.bar(1)
    end
  end

  sig {params(num1: Integer, num2: String).returns(Integer)}
  def self.bar(num1, num2)
    4 + num1 + num2.to_i
  end

  sig {params(arg: String).returns(String)}
  def baz(arg)
    arg + self.class.bar(1, "2").to_s
  end

  sig {params(arg: String).returns(String)}
  def baz2(arg)
    arg + self.class.bar(1, "2").to_s
  end

  sig {params(num: Integer).returns(String)}
  def quux(num)
    if num < 10
      s = 1
    else
      s = "1"
    end
    s.to_s
  end
end

